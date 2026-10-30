/**
 * Unattended durable-session turns — who may resume a stored CLI session, and
 * what an unattended run does when it cannot.
 *
 * Production 1.2.40 (Threads automation f7a61706, run 02:00Z 2026-09-24): the
 * graph ran its `publish` and `measure` nodes in parallel. Both belong to the
 * same automation ledger chat and agent, so both read the same stored Codex
 * thread and both ran `codex exec resume <thread>`. Codex allows one writer per
 * thread; the second process exited 1 before any turn started with
 * "thread-store conflict: thread … already has an active writer" (reproduced on
 * codex-cli 0.156.1). The runner then refused to create a fresh session, so the
 * automation stopped with "restore the session before continuing" — a request
 * nobody can answer in an unattended run.
 *
 * Rules kept here, in one place, for every CLI runner:
 *   1. A stored session is resumed by at most one in-flight turn of this
 *      process. A parallel sibling does not attempt the conflicting resume; it
 *      runs in a fresh session and does not overwrite the durable one.
 *   2. A resume that failed before the runtime started a turn has done nothing
 *      external, so an unattended run continues in a fresh session. Continuity
 *      comes from the host-recorded capsule the automation prompt already
 *      carries (automation-progress-facts.ts), not from the provider thread.
 *   3. A resume whose turn already started may have acted; it is never replayed
 *      in a fresh session (that could repeat an external action).
 *   4. An attended (owner) turn whose stored session the runtime itself reports
 *      as gone also continues in a fresh session that replaces the binding
 *      (attendedTurnStartsFresh). Refusing it was a dead end: the owner got the
 *      same error on every later turn of that chat until something cleared the
 *      binding (2026-10-16: 275 Codex bindings on the owner's Mac named rollouts
 *      that no longer existed anywhere).
 *   5. An attended turn whose resume the runtime's own protocol request timed out on (Codex app-server thread/resume or
 *      thread/fork, a typed AcpTimeoutError before any turn/start) also continues in a fresh session that replaces the
 *      binding, under the same condition as rule 4 (the host can hand it the conversation). Nothing reached the model, and
 *      the stored thread does not open within the bound again: YouTube room 2026-10-28, a 15-day thread whose rollout had
 *      grown to 1.7 GB timed out at 120 s on the owner's turn, on the model fallback that resumed the same thread, and on
 *      every later message, while the owner was told only "The run failed ...".
 *   6. An attended turn whose resume the runtime REFUSED before any turn started, for a reason none of the above names (Codex
 *      app-server `thread/resume` answered with an error or lost its transport; an ACP agent answered `session/load` with a
 *      JSON-RPC error), continues in a fresh session too, under the same condition (the host can hand it the conversation),
 *      with the reason "resume_refused". Only a caller that PROVES the refusal came before any turn started may use that
 *      reason, so nothing reached the model and nothing can be repeated. The stored binding is kept (unlike rules 4 and 5):
 *      the refusal may be transient ("database is locked" while another process holds the state store), the next turn
 *      tries the stored thread again and the gap-replay fills in this turn. An owner who was told "The run failed ..." had
 *      nothing to do but resend into the same refusal. A `codex exec resume` failure is NOT such a proof (its stdin was
 *      already dispatched) and keeps its refusal.
 * Every fresh-session decision emits one machine-readable status receipt.
 */

export type UnattendedFreshSessionReason =
  | "parallel_turn"
  | "writer_busy"
  | "session_not_found"
  | "resume_failed_before_turn"
  | "resume_timed_out"
  | "resume_refused";

const activeTurns = new Map<string, number>();

const turnKey = (kind: string, sessionId: string): string => `${kind}\0${sessionId}`;

export interface RuntimeSessionTurnClaim {
  /** Another in-flight turn of this process already holds this stored session. */
  contended: boolean;
  release(): void;
}

/**
 * Claim the right to resume one stored runtime session for the duration of a
 * turn. Only unattended runs claim: interactive chats are serialized by their
 * own composer and keep their existing recovery path.
 */
export function claimRuntimeSessionTurn(input: {
  kind: string;
  sessionId: string | null | undefined;
  unattended: boolean | undefined;
}): RuntimeSessionTurnClaim {
  const sessionId = input.sessionId?.trim();
  if (!input.unattended || !sessionId) return { contended: false, release: () => {} };
  const key = turnKey(input.kind, sessionId);
  const held = activeTurns.get(key) ?? 0;
  if (held > 0) return { contended: true, release: () => {} };
  activeTurns.set(key, 1);
  let released = false;
  return {
    contended: false,
    release: () => {
      if (released) return;
      released = true;
      activeTurns.delete(key);
    },
  };
}

/** Test/diagnostic view: whether a stored session is held by an in-flight turn. */
export function runtimeSessionTurnActive(kind: string, sessionId: string): boolean {
  return (activeTurns.get(turnKey(kind, sessionId)) ?? 0) > 0;
}

/**
 * Codex resume failure → typed reason. Codex reports both conditions as a
 * JSON-RPC -32600 on stderr with no structured stream event, so the stderr line
 * is the only machine evidence the CLI gives; the match is anchored to its fixed
 * protocol phrases and anything else stays the generic pre-turn reason.
 */
export function classifyCodexResumeFailure(stderr: string): UnattendedFreshSessionReason {
  if (/already has an active writer/.test(stderr)) return "writer_busy";
  if (/no rollout found for thread id/.test(stderr)) return "session_not_found";
  return "resume_failed_before_turn";
}

/**
 * Rule 4: an attended turn starts fresh only when the resume source is definitively gone (the runtime's own not-found
 * report: Codex "no rollout found", Claude's zero-turn error result that names no typed startup_failure_reason, an ACP
 * not-found marker or a missing session folder) and the host can hand the new session the conversation: the chat's
 * own history (a resume from the stored binding) or the agent-context journal (a resume of its native handle). A
 * caller-managed session id with neither keeps the refusal, and so does every transient refusal (writer busy, an
 * unclassified failure): those may succeed on retry. A Claude start the CLI refused and named (a zeroed result with
 * a typed startup_failure_reason such as session_held_by_background) is such a refusal, not a missing session: the
 * binding stays and the turn is returned typed and pre-dispatch (claude-code.ts claudeStartupRefusal, 756939df).
 */
export function attendedTurnStartsFresh(reason: UnattendedFreshSessionReason, conversationCarried: boolean): boolean {
  return (reason === "session_not_found" || reason === "resume_timed_out" || reason === "resume_refused") && conversationCarried;
}

/** The one status receipt for a fresh-session decision (parsed by the run ledger as a status line). */
export function unattendedFreshSessionStatus(kind: string, reason: UnattendedFreshSessionReason): string {
  return `[runtime-session] fresh_session kind=${kind} reason=${reason}`;
}

/**
 * Whether the fresh session should replace the stored one. A sibling that ran
 * fresh only because another turn owns the durable session must not overwrite
 * it; a session that no longer exists (or could not be reopened) is replaced.
 */
export function freshSessionReplacesStored(reason: UnattendedFreshSessionReason): boolean {
  return reason !== "parallel_turn" && reason !== "writer_busy" && reason !== "resume_refused";
}
