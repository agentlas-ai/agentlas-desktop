import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

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
  purpose?: "preparation";
  begin: (admission: AdapterEffectAdmission) => void;
  finish: (scopeId: string, report: AdapterEffectReport) => void;
}
const context = new AsyncLocalStorage<Scope>();

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
