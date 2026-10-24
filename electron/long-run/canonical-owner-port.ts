import type {GoalWaitObservationData} from "./goal-wait-observation";
// OUTPUT-only v1 host interface. Original v0 remains immutable; no installed product change.
import type { GoalWaitIntent, ParsedGoalWait } from "./wait-emitter";
import type { GoalWaitObservation, GoalWaitHostOwner } from "./wait-subscriptions";
import type { TimerWaitAuthority } from "./goal-deadline";
/** Persistable exact source identity, never by itself a grant. No inferred ChatGoalRevision. */
export interface CanonicalGoalWaitOwnerRef {
  domain: "science";
  projectId: string;
  conversationId: string;
  loopSessionId: string;
  chatId: string;
  sourceTurnId: string;
  sourceInvocationId: string;
}
/** Host-only opaque values. The single registered adapter owns their private WeakMaps. */
export type CanonicalGoalWaitSourceToken = Readonly<Record<never, never>>;
export type CanonicalGoalWaitPrepared = Readonly<Record<never, never>>;
export interface CanonicalGoalWaitOwnerSnapshot {
  ref: Readonly<CanonicalGoalWaitOwnerRef>;
  /** Actual canonical contract + loop + Stop + budget + actor/account/runtime binding digest. */
  ownerStamp: string;
  /** Original source/control anchor revalidated against current canonical rows. */
  sourceStamp:string;
  /** Only an actual saved preparation matching the shared reservation. */
  preparedRunId:string|null;
  owner: Readonly<GoalWaitHostOwner>;
  sourceSettled: boolean;
  /** Actual research resource budget deadline; never a shared wait expiry. */
  resourceDeadline: string | null;
  /** Actual domain deadline/ongoing authority; never inferred from a projection. */
  timerAuthority: TimerWaitAuthority;
  state: "source-settled" | "held" | "stopped" | "terminal" | "unavailable";
  sourceToken: CanonicalGoalWaitSourceToken;
}
/** Composition-only DI. Never serialized as a model/MCP/renderer request. */
export interface CanonicalGoalWaitOwnerProvider {
  readonly domain: "science";
  /** Actual exclusive host lease/readiness fence. Composition-only, not DTO proof. */
  assertCurrentOwner(owner:Readonly<GoalWaitHostOwner>):void;
  /** Reconstructs a source ref from exact durable event run/chat using actual
   * canonical rows; no event prefix, projection or supplied ref grants it. */
  resolveSource(input:{chatId:string;sourceInvocationId:string}):Readonly<CanonicalGoalWaitOwnerRef>|null;
  /** Exact canonical rows/ownership and source final/effect boundaries, not a projection status. */
  readOwner(ref: Readonly<CanonicalGoalWaitOwnerRef>): CanonicalGoalWaitOwnerSnapshot | null;
  /** Exact canonical same-project subject binding, checked on every observation. */
  authorizeInvocationSubject(sourceToken:CanonicalGoalWaitSourceToken,subject:{chatId:string;invocationRunId:string}):boolean;
  /** Suppresses independent continuation while the common engine owns this exact wait. No new queued successor. */
  holdCurrentSource(input: { sourceToken: CanonicalGoalWaitSourceToken; waitId: string; intent: GoalWaitIntent }): void;
  /** One source -> stable reserved run. Uses actual existing SDK dispatch compiler in prepare-only mode. */
  prepareContinuation(input: {
    sourceToken: CanonicalGoalWaitSourceToken; waitId: string; reservedRunId: string;
    expectedOwnerStamp: string; intent: GoalWaitIntent; observation: GoalWaitObservation; observationData:GoalWaitObservationData;
  }): CanonicalGoalWaitPrepared;
  /** The adapter privately pins BOTH pre-prepare sourceStamp and the post-prepare
   * canonical stamp: actual SDK preparation legitimately advances the loop.
   * Actual-start checks the latter, plus unchanged source/contract/wait anchors. */
  admitAndStart(prepared: CanonicalGoalWaitPrepared):
    {start:true;runId:string}|{start:false;reason:string;retryAt:string};
  /** Host receipt only. Missing receipt after a persisted claim is unknown, never permission to replay. */
  continuationReceipt(input: { ref: Readonly<CanonicalGoalWaitOwnerRef>; waitId: string; reservedRunId: string }):
    {runId:string; status:"running"|"completed"|"failed"|"cancelled"|"interrupted"} | null;
  /** Changes only canonical wait hold metadata; no Stop/approval/budget grant. */
  releaseHold(input: {ref: Readonly<CanonicalGoalWaitOwnerRef>;waitId:string;reason:string}): void;
}
/** Proposed SDK host ingress after exact source final/settlement; no input authority in ParsedGoalWait. */
export interface CanonicalGoalWaitIntake {
  /** Reads the exact durable source proposal even before source settlement.
   * SDK settlement/recovery checks it BEFORE independent auto-preparation. */
  read(ref: Readonly<CanonicalGoalWaitOwnerRef>): {
    waitId:string|null;
    state:"proposed"|"pending"|"prepared"|"claimed"|"dispatched"|"blocked"|"expired"|"cancelled";
    reservedRunId:string|null;
  }|null;
  /** Missing proposal means reread exact common source event, never text reparse. */
  hold(input: {ref: Readonly<CanonicalGoalWaitOwnerRef>; proposal?: ParsedGoalWait}):
    {status:"registered";waitId:string;nextCheckAt:string|null}|{status:"refused";code:string};
}
