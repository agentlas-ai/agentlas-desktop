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
import { createHash } from "node:crypto";
import { composeDeclaredPrompt, type DeclaredPromptPart } from "../runtime/prompt-order";
import { composeResumeTurnPrompt } from "../runtime/continuity";
import type { RuntimeLocale } from "../runtime/status-i18n";
import { WORK_PROJECT_RESIDENCY_BUSY_CODE, runnerRefusedBeforeDispatch, runnerResultRefusedBeforeDispatch } from "../runtime/runner-pre-dispatch";
import { decideGeneration } from "../runtime/session-generation";

export const BORROWED_SESSION_MODE_KEY = "session-scope.borrowed";
export type BorrowedSessionMode = "shared" | "off";

/**
 * Runtimes that take a per-turn context apart from the system prompt. claude-code, codex, kimi and antigravity are the set the main
 * conversation path uses; grok, cursor and the open ACP seats (github-copilot-cli) run through the same ACP runner as kimi, which hands the
 * turn context over per turn for every spec. Their legacy hand drivers do not (grok bakes the context into a cold system text, cursor has no
 * session), so grok and cursor share only while the ACP runner is the one in use.
 */
const SESSION_CONTEXT_RUNTIMES: ReadonlySet<string> = new Set(["claude-code", "codex", "kimi", "antigravity", "grok", "cursor", "acp"]);
const ACP_ONLY_WHEN_ACTIVE: ReadonlySet<string> = new Set(["grok", "cursor"]);

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
  /** AGENTLAS_DISABLE_ACP restored this kind's legacy driver. */
  acpDisabled?: boolean;
  /** The open ACP seat's spec id (kind "acp"): without it the session cannot be named or dropped. */
  acpAgentId?: string | null;
}): boolean {
  if (!(input.mode === "shared" && input.role === "worker" && !input.review && !input.agentAppMode
    && SESSION_CONTEXT_RUNTIMES.has(input.runtimeKind))) return false;
  if (ACP_ONLY_WHEN_ACTIVE.has(input.runtimeKind) && input.acpDisabled === true) return false;
  if (input.runtimeKind === "acp" && !(input.acpAgentId && input.acpAgentId.trim())) return false;
  return true;
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
 * Everything one worker turn needs to know about its session, decided in ONE place so the call site and the gate cannot disagree: whether it
 * holds the shared session (the claim), which owner string its runner request carries, and whether that session is its own alone. The drop
 * and the request MUST use `turnOwner`: a turn that lost the claim runs under a packet-specific owner, and dropping the shared owner instead
 * would destroy the winner's session while leaving the loser's behind.
 */
export function planBorrowedWorkerTurn(input: { base: string; role: string; attempt: number; candidate: boolean; invocationId: string }): {
  claim: (() => void) | null; shared: boolean; ephemeral: boolean; turnOwner: string;
} {
  const claim = input.candidate ? claimBorrowedWorkerSession(borrowedWorkerSessionOwnerId(input.base, input.role, input.attempt, true)) : null;
  const shared = input.candidate && claim !== null;
  const ephemeral = input.candidate && !shared;
  return { claim, shared, ephemeral,
    turnOwner: borrowedWorkerSessionOwnerId(input.base, input.role, input.attempt, shared, ephemeral ? input.invocationId : undefined) };
}

/**
 * Failures that prove nothing about the session itself never drop it: another writer holds it, the project's slot is busy, a retired process
 * has not exited yet, and in general a refusal the runner typed as not dispatched (`turnDelivery: "not-dispatched"`: claude's startup refusals
 * such as session_held_by_background, which state "the binding stays", a codex turn/start refused while a compaction runs, ACP quota, auth and
 * capacity refusals raised before the prompt is sent; a refusal that comes back as the prompt's own answer is not marked and still drops it).
 * Dropping the session for those loses a healthy conversation, and for session_held_by_background it starts a second one
 * beside the one still running. Looked up through the whole `cause` chain, because the task force wraps every runner failure (returned or
 * thrown) in a TaskForceRuntimeFailureError that carries the original only as its cause. A refusal that names the SESSION itself is the
 * exception and still drops it: a refused resume, a missing session, and codex's own exec/turn-start refusals (their code does not say whether
 * the thread is gone). The runners already clear a row they know is gone; this only decides what a refusal leaves behind.
 */
const SESSION_UNTOUCHED_CODES: ReadonlySet<string> = new Set([
  "runtime_session_owner_busy", WORK_PROJECT_RESIDENCY_BUSY_CODE, "runtime_retired_cli_exit_timeout",
  // Refused by the wrappers around the runner (invocation breaker, subscription gate) before it was reached.
  "runtime_invocation_storm", "subscription_credits_disabled",
]);
const SESSION_NAMED_REFUSAL = /resume|session[_-](?:gone|missing|not[_-]found|lost)|conversation[_-](?:missing|not[_-]found)|rollout|codex_(?:exec_refused_before_turn|turn_start_refused)/i;
export function failureLeavesSessionUntouched(value: unknown): boolean {
  let current: unknown = value;
  let notDispatched = false;
  const codes: string[] = [];
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const record = current as { code?: unknown; providerCode?: unknown; failure?: { providerCode?: unknown; code?: unknown } | null; cause?: unknown };
    for (const code of [record.code, record.providerCode, record.failure?.providerCode, record.failure?.code]) if (typeof code === "string") codes.push(code);
    if (runnerRefusedBeforeDispatch(current) || runnerResultRefusedBeforeDispatch(current as never)) notDispatched = true;
    current = record.cause;
  }
  if (codes.some((code) => SESSION_UNTOUCHED_CODES.has(code))) return true;
  return notDispatched && !codes.some((code) => SESSION_NAMED_REFUSAL.test(code));
}

/**
 * When a worker that kept breaking the handoff contract is escalated, its shared session holds the bad replies. It is dropped, but only while
 * nobody holds the claim: a parallel packet of the same agent may be mid-turn in it.
 */
export function releaseIdleSharedWorkerSession(base: string, drop: (ownerId: string) => void): boolean {
  const owner = borrowedWorkerSessionOwnerId(base, "worker", 1, true);
  const claim = claimBorrowedWorkerSession(owner);
  if (!claim) return false;
  try { drop(owner); } catch { /* the escalation goes on */ } finally { claim(); }
  return true;
}

/**
 * Runtimes whose runner has no window management of its own on this path (claude-code compacts natively at 80% of the window, and codex
 * compacts natively too, model_auto_compact_token_limit): their sessions would otherwise grow with every stage of every run. After a successful turn that already used 80% of the
 * model's window (the same rule the main conversation applies, session-generation.ts) the session is dropped, so the next stage starts a fresh
 * one. Without a known window the provider's own behaviour stays in charge.
 */
const SESSIONS_WITHOUT_HOST_ROTATION: ReadonlySet<string> = new Set(["kimi", "grok", "cursor", "acp", "antigravity"]);
export function borrowedSessionOutgrewWindow(
  kind: string, usage: { contextInputTokens?: number; contextWindowTokens?: number } | null | undefined, fallbackWindow: number | null,
): boolean {
  if (!SESSIONS_WITHOUT_HOST_ROTATION.has(kind) || !usage) return false;
  return decideGeneration({ kind, contextWindowTokens: usage.contextWindowTokens ?? fallbackWindow, lastInputTokens: usage.contextInputTokens ?? null })
    .action === "new_generation";
}

/**
 * Runs one worker turn that holds a claim. A turn that failed, was refused or stopped leaves its session in an unknown state, so the session
 * is dropped and the next stage of this agent starts cleanly instead of resuming a damaged conversation, with three exceptions that never
 * damage it: a failure that proves the session was not touched (`failureLeavesSessionUntouched`), a failure before the runner was entered
 * at all (`entered` false: the capability preparation, a cancelled lease), and success. A successful turn still ends the session when
 * `rotate` says its context is full. A turn without a claim runs in a session of its own and never drops the shared one; when that session is
 * `ephemeral` (nobody will ever resume it, its owner string is unique to the turn) it is dropped once the turn is over, whatever the outcome.
 * The claim is released either way, and a drop that itself throws changes nothing about the turn's own result.
 */
export async function runClaimedWorkerTurn<T extends { failure?: unknown }>(
  claim: (() => void) | null, drop: () => void, run: () => Promise<T>,
  options: { entered?: () => boolean; ephemeral?: boolean; rotate?: (result: T) => boolean } = {},
): Promise<T> {
  const entered = options.entered ?? (() => true);
  const dropSafely = (): void => { try { drop(); } catch { /* the turn's own outcome stays what it was */ } };
  try {
    const result = await run();
    if (claim && result && (result as { failure?: unknown }).failure) {
      if (entered() && !failureLeavesSessionUntouched(result)) dropSafely();
    } else if (claim && result && options.rotate) {
      let rotate = false;
      try { rotate = options.rotate(result); } catch { /* an unreadable size never ends a session */ }
      if (rotate) dropSafely();
    }
    return result;
  } catch (error) {
    if (claim && entered() && !failureLeavesSessionUntouched(error)) dropSafely();
    throw error;
  } finally {
    if (options.ephemeral) dropSafely();
    claim?.();
  }
}

/**
 * The identity a shared worker session is resumed under (`sessionFingerprintSeed`, which every runtime this module shares for takes). Without
 * a seed codex hashes the raw MCP launch arguments into its fingerprint, and every worker stage's capability lease mints a new launch
 * handle, so a stage never matched its predecessor and the shared session never resumed. The seed names what makes one conversation another: the agent's stable instructions, the locale,
 * the tool grant (sorted allowed tools, browser-only, isolated MCP config, restricted or untrusted boundaries) and the folder.
 * A change in any of them opens a new session, never a silent resume with the old grant; the launch handles are left out on purpose, because
 * each turn rebinds its own tool table. The host permission is not in the seed: its value is the last line of every turn
 * (taskforce.worker.user.authority), and each runtime applies the turn's permission itself (codex sends the sandbox policy with every turn,
 * claude and ACP reopen their process under it), so a permission change continues the conversation.
 */
export function borrowedWorkerSessionSeed(input: {
  systemPrompt: string; locale?: string | null; unattendedNoAsk?: boolean;
  restrictedReadBoundary?: unknown; untrustedNoTools?: boolean; browserOnly?: boolean; isolatedMcpConfig?: boolean;
  mcpAllowedTools?: readonly string[] | null; cwd?: string | null;
  /** The conversation: codex and ACP key their approval and consent caches by the seed, which must not reach across chats. */
  chatId?: string | null;
  /** The owner's memory-forget counter: a forget ends the conversations that may still hold what was forgotten (the main path rotates on it too). */
  forgetEpoch?: number | null;
}): string {
  const digest = createHash("sha256").update(JSON.stringify([
    input.systemPrompt, input.locale ?? null, input.unattendedNoAsk === true,
    Boolean(input.restrictedReadBoundary), input.untrustedNoTools === true, input.browserOnly === true, input.isolatedMcpConfig === true,
    [...(input.mcpAllowedTools ?? [])].sort(), input.cwd ?? null, input.forgetEpoch ?? 0, input.chatId ?? null,
  ])).digest("hex");
  return `borrowed-worker.v1:${digest}`;
}
