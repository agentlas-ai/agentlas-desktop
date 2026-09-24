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
 * Every fresh-session decision emits one machine-readable status receipt.
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
