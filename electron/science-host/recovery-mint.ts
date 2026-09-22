import { scienceStore } from "agentlas-science";
import { issueScienceRecoveryCapability, resolveScienceRecoveryAuthority, type ScienceRecoveryScope } from "./recovery-authority";
import type { InvocationExecutionContext } from "../mcp/client";
import type { RuntimeSelection } from "../../shared/types";

type RecoveryStore = ReturnType<typeof scienceStore> & {
  assertForwardSteeringRecoveryDispatch(recoveryId: string, turnId: string, invocationRunId: string): unknown;
};
const RECOVERY_SCHEMA = "agentlas.science-forward-recovery-continuation.v1";

/** A durable recovery turn cannot silently enter ordinary Science when its opaque grant is lost. */
export function readScienceRecoveryAuthority(context: InvocationExecutionContext | undefined,
  runId: string, chatId: string, selection: RuntimeSelection | undefined): object | null {
  if (context?.source === "science" && context.science) {
    const turn = scienceStore().getTurnForProject(context.science.projectId, context.science.turnId);
    if (turn?.continuationBasis?.schema === RECOVERY_SCHEMA && context.scienceRecovery === undefined)
      throw new Error("science_recovery_main_capability_required");
  }
  return resolveScienceRecoveryAuthority(context, runId, chatId, selection);
}

/** Host facade only. The renderer has no route to this function. */
export function mintForwardSteeringRecoveryCapability(input: ScienceRecoveryScope): object {
  const store = scienceStore() as RecoveryStore;
  if (typeof store.assertForwardSteeringRecoveryDispatch !== "function")
    throw new Error("science_recovery_store_authority_unavailable");
  // Copy before retaining the callback: callers cannot mutate the exact scope after minting.
  const scope = { ...input, science: { ...input.science }, runtimeSelection: { ...input.runtimeSelection } };
  const current = () => {
    const s = scope.science;
    store.assertForwardSteeringRecoveryDispatch(scope.recoveryId, s.turnId, s.invocationRunId);
    const turn = store.getTurnForProject(s.projectId, s.turnId);
    const binding = store.getConversationRuntimeBinding(s.projectId, s.conversationId);
    if (!turn || turn.invocationRunId !== s.invocationRunId || turn.runtimeChatId !== scope.chatId
      || turn.userMessageId !== s.originUserMessageId
      || turn.continuationBasis?.schema !== RECOVERY_SCHEMA || turn.continuationBasis.recoveryId !== scope.recoveryId
      || turn.conversationId !== s.conversationId || binding?.runtimeChatId !== scope.chatId
      || !["queued", "running"].includes(turn.status)
      || JSON.stringify(turn.runtimeSelection) !== JSON.stringify(scope.runtimeSelection)) {
      throw new Error("science_recovery_authority_stale");
    }
    store.assertScienceTurnExecutionAuthority(turn);
  };
  return issueScienceRecoveryCapability(scope, current);
}
