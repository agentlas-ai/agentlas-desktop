/**






























 */

export type UnattendedFreshSessionReason =
  | "parallel_turn"
  | "writer_busy"
  | "session_not_found"
  | "resume_failed_before_turn";

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
  return reason === "session_not_found" && conversationCarried;
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
  return reason !== "parallel_turn" && reason !== "writer_busy";
}
