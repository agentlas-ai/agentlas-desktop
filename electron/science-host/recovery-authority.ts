import { createHash, randomUUID } from "node:crypto";
import type { RuntimeSelection } from "../../shared/types";
import type { InvocationExecutionContext } from "../mcp/client";
import type { RunnerRequest } from "../runtime/runner";
import { isAgentlasServingModel } from "../../shared/agentlas-serving";

/** Main-only future Science writer contract. No IPC/preload mint endpoint. */
export interface ScienceRecoveryScope {
  science: NonNullable<InvocationExecutionContext["science"]>;
  chatId: string;
  recoveryId: string;
  runtimeSelection: RuntimeSelection;
  /** Only current, canonical state/directives belong in this fresh prompt. */
  systemPrompt: string;
  userPrompt: string;
}
type Grant = Readonly<ScienceRecoveryScope> & { ownerId: string; current: () => void };
const grants = new WeakMap<object, Grant>();
const supported = new Set(["codex", "claude-code", "antigravity", "acp", "agentlas", "byok", "lmstudio", "mlx", "agentlas-local"]);
// Only adapters with a stateless provider wire and entry guards are admitted.
const supportedByok = new Set(["anthropic", "openai", "google", "upstage", "custom", "glm",
  "kimi", "deepseek", "minimax", "xai", "openrouter"]);
type Selection = { kind: string; backend?: string | null; model?: string | null; source?: string | null;
  effort?: string | null; acpAgentId?: string | null };
const selectionKey = (s: Selection) => JSON.stringify(
  [s.kind, s.backend ?? null, s.model ?? null, s.source ?? null, s.effort ?? null, s.acpAgentId ?? null],
);
function selectionMatches(actual: Selection, expected: RuntimeSelection): boolean {
  // Detection fills executable source/default effort when the saved selection omitted them.
  return selectionKey({ ...actual, source: expected.source == null ? undefined : actual.source,
    effort: expected.effort == null ? undefined : actual.effort }) === selectionKey(expected);
}
const scienceKey = (s: ScienceRecoveryScope["science"]) => JSON.stringify([
  s.projectId, s.conversationId, s.turnId, s.originUserMessageId, s.invocationRunId,
  s.researchDirectorAgentId, s.researchDirectorAgentSlug, s.researchDirectorPackageVersion,
  s.researchDirectorPackageDigest, s.researchDirectorSystemPromptSha256, s.workflowRoute ?? null,
]);
const scienceFields = new Set(["projectId", "conversationId", "turnId", "originUserMessageId", "invocationRunId",
  "researchDirectorAgentId", "researchDirectorAgentSlug", "researchDirectorPackageVersion",
  "researchDirectorPackageDigest", "researchDirectorSystemPromptSha256", "workflowRoute"]);
function onlyScienceScopeFields(s: ScienceRecoveryScope["science"]): boolean {
  return Object.keys(s).every(key => scienceFields.has(key));
}

/** assertCurrent must synchronously re-read the exact durable recovery/turn authority.
 * This API does not create recovery state; Science's store/service writer is still required. */
export function issueScienceRecoveryCapability(scope: ScienceRecoveryScope, assertCurrent: () => void): object {
  if (!scope.chatId?.trim() || !scope.recoveryId?.trim() || !scope.systemPrompt?.trim() || !scope.userPrompt?.trim()
    || !scope.science || !onlyScienceScopeFields(scope.science)
    || ![scope.science.projectId, scope.science.conversationId, scope.science.turnId, scope.science.invocationRunId,
      scope.science.originUserMessageId, scope.science.researchDirectorAgentId, scope.science.researchDirectorAgentSlug,
      scope.science.researchDirectorPackageVersion, scope.science.researchDirectorPackageDigest,
      scope.science.researchDirectorSystemPromptSha256].every(value => typeof value === "string" && value.trim())
    || !supported.has(scope.runtimeSelection?.kind) || !scope.runtimeSelection.model?.trim()
    || (scope.runtimeSelection.kind === "byok" && !supportedByok.has(scope.runtimeSelection.backend ?? ""))
    || (scope.runtimeSelection.kind === "agentlas" && !isAgentlasServingModel(scope.runtimeSelection.model))
    || (scope.runtimeSelection.kind === "acp" && !scope.runtimeSelection.acpAgentId?.trim())
    || typeof assertCurrent !== "function") throw new Error("science_recovery_scope_invalid");
  assertCurrent();
  const capability = Object.freeze({});
  const ownerId = `science-recovery:${createHash("sha256").update(JSON.stringify([
    scope.recoveryId, scope.science.invocationRunId, scope.chatId,
  ])).digest("hex")}:${randomUUID()}`;
  grants.set(capability, Object.freeze({ ...scope, science: Object.freeze({ ...scope.science }),
    runtimeSelection: Object.freeze({ ...scope.runtimeSelection }), ownerId, current: assertCurrent }));
  return capability;
}

function readGrant(capability: object): Grant {
  const grant = grants.get(capability);
  if (!grant) throw new Error("science_recovery_main_capability_required");
  grant.current();
  return grant;
}

/** Admission before any hidden transcript is read, and again after dispatch awaits. */
export function resolveScienceRecoveryAuthority(context: InvocationExecutionContext | undefined,
  runId: string, chatId: string, selection: Selection | undefined): object | null {
  if (context?.scienceRecovery === undefined) return null;
  const capability = context.scienceRecovery;
  const grant = readGrant(capability);
  if (context.source !== "science" || !context.science || context.scienceReview
    || runId !== grant.science.invocationRunId || chatId !== grant.chatId
    || !onlyScienceScopeFields(context.science) || scienceKey(context.science) !== scienceKey(grant.science)
    || !selection || !selectionMatches(selection, grant.runtimeSelection)) {
    throw new Error("science_recovery_scope_mismatch");
  }
  return capability;
}

/** Last override at dispatch: stale history, surfaceContext, tool summaries and checkpoints cannot leak. */
export function freshScienceRecoveryRequest(req: RunnerRequest, capability: object): RunnerRequest {
  const grant = readGrant(capability);
  if (req.chatId !== grant.chatId || req.agentId !== grant.science.researchDirectorAgentId)
    throw new Error("science_recovery_runner_scope_mismatch");
  return { ...req, scienceRecoveryCapability: capability, history: [], systemPrompt: grant.systemPrompt,
    userPrompt: grant.userPrompt, surfaceUserPrompt: grant.userPrompt, turnContext: undefined,
    turnContextStable: undefined, images: undefined, runtimeSessionId: undefined,
    runtimeSessionOwnerId: grant.ownerId, sessionFingerprintSeed: grant.ownerId,
    singleUse: true, unattended: true, noSynchronousAsk: true };
}

/** Provider boundary: reject tampering/stale authority before session lookup or prompt construction. */
export function assertScienceRecoveryRequest(req: RunnerRequest, runtimeKind?: string, backend?: string): boolean {
  if (req.scienceRecoveryCapability === undefined) {
    if (req.runtimeSessionOwnerId?.startsWith("science-recovery:"))
      throw new Error("science_recovery_main_capability_required");
    return false;
  }
  const grant = readGrant(req.scienceRecoveryCapability);
  if (req.chatId !== grant.chatId || req.agentId !== grant.science.researchDirectorAgentId
    || (runtimeKind !== undefined && runtimeKind !== grant.runtimeSelection.kind)
    || (runtimeKind === "byok" && backend !== grant.runtimeSelection.backend)
    || req.model !== grant.runtimeSelection.model
    || (grant.runtimeSelection.effort != null && req.effort !== grant.runtimeSelection.effort)
    || req.runtimeSessionOwnerId !== grant.ownerId || req.sessionFingerprintSeed !== grant.ownerId
    || req.singleUse !== true || req.unattended !== true || req.noSynchronousAsk !== true
    || req.runtimeSessionId !== undefined || req.history.length !== 0
    || req.turnContext !== undefined || req.turnContextStable !== undefined || req.images !== undefined
    || req.systemPrompt !== grant.systemPrompt || req.userPrompt !== grant.userPrompt
    || req.surfaceUserPrompt !== grant.userPrompt) {
    throw new Error("science_recovery_runner_scope_mismatch");
  }
  return true;
}
