import { scienceStore } from "agentlas-science";
import { supportsScienceCollectionRuntime } from "../runtime/science-collection-boundary";
import type { InvocationExecutionContext } from "../mcp/client";
import type { RuntimeSelection } from "../../shared/types";

/** Structural until the separately released Science package exports this API. */
type Store = ReturnType<typeof scienceStore> & {
  collectionEffectAuthority(turn: object): unknown;
  assertScienceTurnEffect(turn: object, boundary: string, route: undefined, restricted: boolean): void;
};
export function readScienceCollectionAuthority(context: InvocationExecutionContext | undefined, runId: string, chatId: string, selection: RuntimeSelection | undefined): (() => void) | null {
  if (context?.source !== "science" || !context.science) return null;
  const scope = context.science;
  const store = scienceStore() as Store;
  if (typeof store.collectionEffectAuthority !== "function") return null;
  const turn = store.getTurnForProject(scope.projectId, scope.turnId);
  if (!turn) throw new Error("science_collection_turn_missing");
  const authority = store.collectionEffectAuthority(turn);
  if (!authority) return null;
  const authorityPin = JSON.stringify(authority);
  const selectionPin = JSON.stringify(turn.runtimeSelection);
  if (!supportsScienceCollectionRuntime(turn.runtimeSelection) || selectionPin !== JSON.stringify(selection)) {
    throw new Error("science_collection_transport_unsupported");
  }
  const current = () => {
    const live = store.getTurnForProject(scope.projectId, scope.turnId);
    const binding = store.getConversationRuntimeBinding(scope.projectId, scope.conversationId);
    if (!live || live.invocationRunId !== runId || live.runtimeChatId !== chatId
      || scope.invocationRunId !== runId || live.conversationId !== scope.conversationId
      || binding?.runtimeChatId !== chatId || !["queued", "running"].includes(live.status)
      || JSON.stringify(live.runtimeSelection) !== selectionPin
      || JSON.stringify(store.collectionEffectAuthority(live)) !== authorityPin) {
      throw new Error("science_collection_authority_stale");
    }
    store.assertScienceTurnExecutionAuthority(live);
    store.assertScienceTurnEffect(live, "runtime-dispatch", undefined, true);
  };
  current();
  return current;
}
