import type { SupervisorCommandReceipt } from "./one-supervisor";

/** The command journal is separate from each run's ordered token/tool stream. */
export const ONE_SUPERVISOR_JOURNAL_SCHEMA = "agentlas.one-supervisor-journal.v1" as const;
export interface SupervisorJournalInput { oneId: string; afterCursor: number; limit?: number }
export interface SupervisorJournalEvent { cursor: number; commandId: string; receipt: SupervisorCommandReceipt; recordedAt: string }
export interface SupervisorJournalPage {
  schema: typeof ONE_SUPERVISOR_JOURNAL_SCHEMA;
  oneId: string;
  events: SupervisorJournalEvent[];
  nextCursor: number;
  latestCursor: number;
  hasMore: boolean;
  /** A cursor from a future/different store must be replaced by a fresh snapshot. */
  resetRequired: boolean;
}
export interface SupervisorRuntimeOwner {
  ownerEpoch: string;
  ownerKind: "desktop-main" | "work-daemon";
  oneId: string;
  generation: number;
  leaseUntil: number;
  phase: "active" | "draining" | "released";
}
export interface SupervisorStopInput {
  commandId: string;
  oneId: string;
  taskId: string;
  runId: string;
  expectedVersion: string;
}
export interface SupervisorControlProgress {
  /** A delivered cancellation is not proof that the process stopped. */
  phase: "requested" | "delivered" | "stopped" | "settled" | "rejected" | "unknown";
  requestedAt: string;
  observedAt: string;
}

/** Main/daemon admission is denied before handoff on any compatibility mismatch. */
export const ONE_SUPERVISOR_RUNTIME_PROTOCOL = "agentlas.one-supervisor-runtime.v1" as const;
/** Closed native domain set. An older host cannot own new personal/Vault operations. */
export const ONE_SUPERVISOR_EXTENSIONS_SCHEMA = 'agentlas.one-personal-vault84.v1' as const;

/** Signed native transport canonicalizes object keys; compare the closed value
 * set rather than insertion order. Unknown fields are a version mismatch. */
export function sameSupervisorRuntimeCompatibility(actual:unknown,expected:Readonly<Record<string,string|number|undefined>>):boolean {
  if(!actual || typeof actual!=="object" || Array.isArray(actual))return false;
  const value=actual as Record<string,unknown>,keys=Object.keys(expected);
  return Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key)&&value[key]===expected[key]);
}
