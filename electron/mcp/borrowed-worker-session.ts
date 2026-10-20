/**
 * One session for a borrowed (hub network) agent's own turns, instead of a new one for every stage.
 *
 * Until now a stage of a task force opened a native session under a key that carried the attempt, and put everything that changes from
 * stage to stage (retrieved memory, runtime context, the correction after a failed check) into the SYSTEM prompt. The runtimes fingerprint
 * the system prompt, so even a key that stayed the same would not have resumed, and nearly every borrowed stage
 * started cold: the agent forgot what it had read and done a moment before. Two changes make the agent continue:
 *   1. the key names the task force's chat and the agent (and its role), not the attempt;
 *   2. what changes per stage travels as the turn's own context, exactly where the main conversation path puts it for these runtimes
 *      (mcp/client.ts: systemPrompt stable, turnContext per turn), so the system prompt - and with it the fingerprint - stays equal.
 * Pinning the fingerprint alone would be wrong: Codex keeps only the first developer instructions and Claude a system prompt snapshot, so
 * the per-stage memory and corrections would silently vanish. A changed agent definition still changes the fingerprint and opens a new
 * session. An independent review step ("new eyes") never shares a session.
 *
 * Switch (meta key `session-scope.borrowed`): unset or `shared` = this behaviour; any other value, or a failure to read it, = the old one.
 * This file imports no Electron.
 */
import { composeDeclaredPrompt, type DeclaredPromptPart } from "../runtime/prompt-order";
import { composeResumeTurnPrompt } from "../runtime/continuity";
import type { RuntimeLocale } from "../runtime/status-i18n";

export const BORROWED_SESSION_MODE_KEY = "session-scope.borrowed";
export type BorrowedSessionMode = "shared" | "off";

/** Runtimes that take a per-turn context apart from the system prompt (the same set the main conversation path uses). */
const SESSION_CONTEXT_RUNTIMES: ReadonlySet<string> = new Set(["claude-code", "codex", "kimi", "antigravity"]);

export function borrowedSessionMode(read: (key: string) => string | null): BorrowedSessionMode {
  try {
    const value = read(BORROWED_SESSION_MODE_KEY);
    return value === null || value === "shared" ? "shared" : "off";
  } catch {
    return "off";
  }
}

/** Does this worker turn continue the agent's session? Never for a review step, a site agent app, or a runtime without a turn context. */
export function borrowedWorkerSessionIsShared(input: {
  mode: BorrowedSessionMode; role: "worker" | "orchestrator"; review: boolean; runtimeKind: string; agentAppMode: boolean;
}): boolean {
  return input.mode === "shared" && input.role === "worker" && !input.review && !input.agentAppMode
    && SESSION_CONTEXT_RUNTIMES.has(input.runtimeKind);
}

/**
 * `base` is the task force's session id for this agent (chat and agent slug). A shared turn drops the attempt from the key. `packetId`
 * names the turn that wanted the shared session but found it claimed: it gets a session that is its own, not one it could meet a third
 * parallel packet in.
 */
export function borrowedWorkerSessionOwnerId(base: string, role: string, attempt: number, shared: boolean, packetId?: string): string {
  if (shared) return `${base}:${role}`;
  return packetId ? `${base}:${role}:${attempt}:${packetId}` : `${base}:${role}:${attempt}`;
}

/**
 * The system prompt of the stable parts and the turn context of the per-stage parts. Null when nothing changes per stage (the request
 * keeps its single composed system prompt, byte for byte).
 */
export function splitWorkerSystemParts(parts: readonly DeclaredPromptPart[]): { systemPrompt: string; turnContext: string } | null {
  const perStage = parts.filter((part) => part.stability === "turn-context");
  if (perStage.length === 0) return null;
  const stable = parts.filter((part) => part.stability !== "turn-context");
  const turnContext = composeDeclaredPrompt(perStage, "\n\n");
  if (!turnContext.trim()) return null;
  return { systemPrompt: composeDeclaredPrompt(stable, "\n"), turnContext };
}

/**
 * Where the per-stage context goes for this runtime. claude-code writes the context of a COLD turn into the session's system prompt file and
 * re-appends that file at every resume, so a first stage's memory or correction would stay at system level for the life of the session next
 * to each later stage's fresh copy. It gets the context in the user message instead, framed exactly as a resumed turn frames it. The other
 * runtimes take it as the turn's own `turnContext`.
 */
export function placeWorkerTurnContext(input: {
  runtimeKind: string; systemPrompt: string; userPrompt: string; turnContext: string; locale: RuntimeLocale;
}): { systemPrompt: string; userPrompt: string; turnContext?: string } {
  if (input.runtimeKind === "claude-code") {
    return { systemPrompt: input.systemPrompt, userPrompt: composeResumeTurnPrompt(input.userPrompt, input.turnContext, input.locale) };
  }
  return { systemPrompt: input.systemPrompt, userPrompt: input.userPrompt, turnContext: input.turnContext };
}

/**
 * One native session takes one turn at a time: two independent packets of the same agent that are ready together would both resume the
 * session (claude refuses the second with runtime_session_owner_busy before it starts, the others have no guard at all). The first claims the
 * key; a second turn that finds it taken runs with a session of its own, as before this change. In process: the task force of one run lives
 * in one process.
 */
const claimedKeys = new Set<string>();
export function claimBorrowedWorkerSession(key: string): (() => void) | null {
  if (claimedKeys.has(key)) return null;
  claimedKeys.add(key);
  let released = false;
  return () => { if (!released) { released = true; claimedKeys.delete(key); } };
}

/**
 * Runs one worker turn that holds a claim. A turn that failed, was refused or stopped leaves its session in an unknown state, so the session
 * is dropped and the next stage of this agent starts cleanly instead of resuming a damaged conversation. A turn without a claim runs in a
 * session of its own and never drops the shared one. The claim is released either way.
 */
export async function runClaimedWorkerTurn<T extends { failure?: unknown }>(
  claim: (() => void) | null, drop: () => void, run: () => Promise<T>,
): Promise<T> {
  try {
    const result = await run();
    if (claim && result && (result as { failure?: unknown }).failure) drop();
    return result;
  } catch (error) {
    if (claim) drop();
    throw error;
  } finally {
    claim?.();
  }
}
