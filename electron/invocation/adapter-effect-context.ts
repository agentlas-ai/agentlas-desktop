import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { captureScienceToolCorrelation, type ScienceToolCorrelation } from "./science-failure-settlement";
import { captureScienceNativeFailureObservation, type ScienceNativeFailureObservation } from "./science-native-failure";

export interface AdapterEffectReport {
  schemaVersion: "agentlas.adapter-effect-coverage.v1";
  protocol: string;
  complete: boolean;
  terminal: string | null;
  operationIds: string[];
  frameKinds: string[];
  reasons: string[];
  /** Failed operations with Main-attested definite settlement (e.g. rejected before dispatch). */
  settledFailureIds?: string[];
}
export interface AdapterEffectAdmission {
  scopeId: string; adapterKind: string; chatId: string | null; agentId: string | null;
  rootBound: boolean;
  /** Main-owned dispatch role, not a claim of isolation or effect settlement. */
  purpose?: "preparation";
}
interface Scope {
  runId: string; chatId: string; rootAgentId: string | null;
  source?: string;
  nativeScienceTool?: (binding: ScienceToolCorrelation) => void;
  nativeScienceFailure?: (observation: ScienceNativeFailureObservation) => void;
  purpose?: "preparation";
  begin: (admission: AdapterEffectAdmission) => void;
  finish: (scopeId: string, report: AdapterEffectReport) => void;
}
const context = new AsyncLocalStorage<Scope>();

/** Capture at dispatch; resident callbacks must not borrow another ALS turn.
 * Nested/preparation/non-Science adapters cannot supply root correlation. */
export function bindScienceNativeToolObserver(input: { chatId?: string; agentId?: string }): (item: unknown) => void {
  const scope = context.getStore();
  if (!scope || scope.source !== "science" || scope.purpose === "preparation" || !scope.rootAgentId
    || input.chatId !== scope.chatId || input.agentId !== scope.rootAgentId) return () => {};
  return item => {
    const binding = captureScienceToolCorrelation(scope.runId, scope.chatId, item);
    if (binding) scope.nativeScienceTool?.(binding);
  };
}

/** Bind once in Main's dispatch scope, before any provider/UI truncation. */
export function bindScienceNativeFailureObserver(input: { chatId?: string; agentId?: string }):
  (item: unknown, completionKind: ScienceNativeFailureObservation["completionKind"]) => void {
  const scope = context.getStore();
  if (!scope || scope.source !== "science" || scope.purpose === "preparation" || !scope.rootAgentId
    || input.chatId !== scope.chatId || input.agentId !== scope.rootAgentId) return () => {};
  return (item, completionKind) => {
    const observation = captureScienceNativeFailureObservation(scope.runId, scope.chatId, item, completionKind);
    if (observation) scope.nativeScienceFailure?.(observation);
  };
}

/** Only Main enters this scope. Providers cannot select a run or borrow another run's receipt. */
export function withAdapterEffectContext<T>(scope: Scope, action: () => T): T { return context.run(scope, action); }

/** Preserve the parent's ledger callbacks and run identity. Preparation still
 * needs its real adapter report; this neither detaches nor settles any effects. */
export function withAdapterEffectPreparation<T>(action: () => T): T {
  const scope = context.getStore();
  return scope ? context.run({ ...scope, purpose: "preparation" }, action) : action();
}

/** Call immediately before an actual adapter dispatch, never on adapter selection. */
export function beginAdapterEffectRun(input: { adapterKind: string; chatId?: string; agentId?: string }): { scopeId: string; complete: (report: AdapterEffectReport) => void } | null {
  const scope = context.getStore();
  if (!scope) return null;
  const scopeId = `${scope.runId}:${randomUUID()}`;
  const preparation = scope.purpose === "preparation";
  scope.begin({ scopeId, adapterKind: input.adapterKind, chatId: preparation ? scope.chatId : input.chatId ?? null, agentId: input.agentId ?? null,
    rootBound: !preparation && input.chatId === scope.chatId && scope.rootAgentId !== null && input.agentId === scope.rootAgentId,
    ...(preparation ? { purpose: "preparation" as const } : {}) });
  let finished = false;
  return { scopeId, complete: report => { if (finished) return; finished = true; scope.finish(scopeId, report); } };
}
