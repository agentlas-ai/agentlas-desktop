import type { RuntimeSelection } from "../../shared/types";
import { supervisorError } from "../../shared/one-supervisor";
import { transientSendBackoffMs } from "../../shared/transient-send-refusal";
import type { OneSupervisorStore, SupervisorRequestRow } from "./supervisor-store";
import { sendRefusalCode } from "../../shared/transient-send-refusal";
import { undispatchedInternalFailure } from "../../shared/run-failure-cause";
import type { InvocationRunReceipt } from "../../shared/types";
import { UNCONFIRMED_MAX_RESENDS } from "../invocation/earlier-attempt";

export interface SupervisorDispatchFrame { locale: "ko" | "en"; runtimeSelection: RuntimeSelection | undefined }
/** Older host adapters use this machine code without a typed provider failure. Signing in remains an owner action. */
export function supervisorInternalStartRefusal(error: unknown): boolean {
  const code = sendRefusalCode(error);
  const runtimeFailure = (error as {runtimeFailure?:InvocationRunReceipt["runtimeFailure"]} | null)?.runtimeFailure;
  return code !== "runtime_not_signed_in" && !runtimeFailure && (code === "store_busy" || undispatchedInternalFailure({code,
    runtimeFailure,
    delivery:"not-dispatched"}));
}
interface DispatchRetry {
  version: 1; attempts: number; firstAt: number; notBefore: number; frame: SupervisorDispatchFrame;
  /** Legacy held rows historically recovered up to three times. Persist that stricter sub-budget too. */
  legacyHeldRestarts?: number;
  retryStopped?: true;
  unconfirmedResends?: number;
  priorRunId?: string;
}
/** The original command keeps its frame and cumulative budget when one uncertain run is replaced. */
export function rebindSupervisorUnconfirmed(store: OneSupervisorStore, row: SupervisorRequestRow, nextRunId: string, now = Date.now()): number | null {
  const retry = supervisorDispatchRetry(row);
  if (!retry || retry.retryStopped || (retry.unconfirmedResends ?? 0) >= UNCONFIRMED_MAX_RESENDS || supervisorRetryExhausted(row,now)) return null;
  const notBefore = Math.max(retry.notBefore,now+transientSendBackoffMs(0));
  save(store,row,{...retry,unconfirmedResends:(retry.unconfirmedResends ?? 0)+1,priorRunId:row.run_id!,notBefore});
  store.update(row,{state:"stored",acknowledgement:"stored",reason:"resent_unconfirmed",runId:nextRunId});
  return notBefore-now;
}
/** A known provider/owner verdict must not become an internal retry when recovery later sees only the hold's code. */
export function retainSupervisorStartVerdict(store: OneSupervisorStore, row: SupervisorRequestRow, error: unknown, legacyNoStartProof = false): void {
  const retry = supervisorDispatchRetry(row);
  if (!retry || supervisorInternalStartRefusal(error)) return;
  // Preserve only the old raw sign-in recovery contract, with fresh no-start proof and its durable three-attempt sub-budget.
  // A typed provider verdict, a new command or another owner/safety failure never enters this compatibility path.
  if (legacyNoStartProof && retry.legacyHeldRestarts !== undefined && sendRefusalCode(error) === "runtime_not_signed_in"
    && !(error as {runtimeFailure?:unknown} | null)?.runtimeFailure) return;
  save(store,row,{...retry,retryStopped:true});
}
/** Preserve legacy first recovery without letting process restarts replenish its three immediate recoveries. */
export function resumeLegacySupervisorHeld(store: OneSupervisorStore, row: SupervisorRequestRow, create: () => SupervisorDispatchFrame, now = Date.now()): boolean {
  return store.db.transaction(() => {
    const current = store.get(row.command_id);
    if (!current || current.state !== "held" || current.run_id !== row.run_id) return false;
    const prior = supervisorDispatchRetry(current);
    if (prior && prior.legacyHeldRestarts === undefined) return false;
    const value: DispatchRetry = prior ?? {version:1,attempts:0,firstAt:now,notBefore:0,frame:create()};
    if ((value.legacyHeldRestarts ?? 0) >= 3 || supervisorRetryExhausted(current,now)) return false;
    save(store, current, {...value,legacyHeldRestarts:(value.legacyHeldRestarts ?? 0)+1,notBefore:now});
    store.update(current,{state:"stored",acknowledgement:"stored"});
    return true;
  }).immediate();
}
/** Internal command custody, separate from the immutable ingress hash and public receipt. */
export function supervisorDispatchRetry(row: SupervisorRequestRow): DispatchRetry | null {
  if (!row.dispatch_retry_json) return null;
  const value = JSON.parse(row.dispatch_retry_json) as DispatchRetry;
  if (value.version !== 1 || !Number.isSafeInteger(value.attempts) || value.attempts < 0
    || !Number.isFinite(value.firstAt) || !Number.isFinite(value.notBefore)
    || value.legacyHeldRestarts !== undefined && (!Number.isSafeInteger(value.legacyHeldRestarts) || value.legacyHeldRestarts < 0 || value.legacyHeldRestarts > 3)
    || value.unconfirmedResends !== undefined && (!Number.isSafeInteger(value.unconfirmedResends) || value.unconfirmedResends < 1 || value.unconfirmedResends > UNCONFIRMED_MAX_RESENDS)
    || value.priorRunId !== undefined && (typeof value.priorRunId !== "string" || !value.priorRunId)
    || !value.frame || !["ko", "en"].includes(value.frame.locale)) throw supervisorError("supervisor_retry_metadata_invalid");
  return value;
}
function save(store: OneSupervisorStore, row: SupervisorRequestRow, value: DispatchRetry): void {
  const changed = store.db.prepare(`UPDATE one_supervisor_requests SET dispatch_retry_json=?
    WHERE command_id=? AND one_id=? AND payload_hash=? AND run_id IS ? AND state=? AND dispatch_retry_json IS ?`)
    .run(JSON.stringify(value), row.command_id, row.one_id, row.payload_hash, row.run_id, row.state, row.dispatch_retry_json ?? null);
  if (changed.changes !== 1) throw supervisorError("supervisor_request_state_conflict");
}
/** Read the frame only once, including when the next start is made by a different process/host. */
export function supervisorDispatchFrame(store: OneSupervisorStore, row: SupervisorRequestRow, create: () => SupervisorDispatchFrame, now = Date.now()): SupervisorDispatchFrame {
  return store.db.transaction(() => {
    const current = store.get(row.command_id);
    if (!current || current.run_id !== row.run_id || current.state !== row.state) throw supervisorError("supervisor_request_state_conflict");
    const prior = supervisorDispatchRetry(current);
    if (prior) return prior.frame;
    const value: DispatchRetry = {version: 1, attempts: 0, firstAt: now, notBefore: 0, frame: create()};
    save(store, current, value);
    return value.frame;
  }).immediate();
}
/**
 * A command the host received stays alive until it is delivered: neither an attempt count nor an age ends a start that was refused
 * before dispatch (owner rule). Only a refusal the owner alone can clear (startRefusalNeedsOwner) and the capped backoff
 * (supervisorRefusalDelay) still apply. Kept as a function because the work executor reads it; the attempts counter stays as a log.
 */
export function supervisorRetryExhausted(_row: SupervisorRequestRow, _now = Date.now()): boolean {
  return false;
}
/** A failed host check before queue.begin() is an admission attempt too, even though it cannot have dispatched native work. */
export function countSupervisorPreBeginRefusal(store: OneSupervisorStore, row: SupervisorRequestRow, now = Date.now()): void {
  const retry = supervisorDispatchRetry(row);
  if (!retry) throw supervisorError("supervisor_retry_frame_missing");
  if (!supervisorRetryExhausted(row,now)) save(store,row,{...retry,attempts:retry.attempts+1});
}
/** Reserve BEFORE invoking native code: a crash or lost ACK cannot reset or omit an attempt. */
export function reserveSupervisorDispatch(store: OneSupervisorStore, row: SupervisorRequestRow, now = Date.now()): "ready" | "wait" | "exhausted" {
  return store.db.transaction(() => {
    const current = store.get(row.command_id);
    if (!current || current.run_id !== row.run_id || current.state !== "dispatching") throw supervisorError("supervisor_request_state_conflict");
    const retry = supervisorDispatchRetry(current);
    if (!retry) throw supervisorError("supervisor_retry_frame_missing");
    if (supervisorRetryExhausted(current, now)) return "exhausted";
    if (retry.notBefore > now) return "wait";
    save(store, current, {...retry, attempts: retry.attempts + 1, notBefore: now + transientSendBackoffMs(retry.attempts)});
    return "ready";
  }).immediate();
}
/** A refusal and a recovered never-started hold share the same durable deadline and backoff. */
export function supervisorRefusalDelay(store: OneSupervisorStore, row: SupervisorRequestRow, now = Date.now()): number {
  const retry = supervisorDispatchRetry(row);
  if (!retry) throw supervisorError("supervisor_retry_frame_missing");
  const notBefore = Math.max(retry.notBefore, now + transientSendBackoffMs(Math.max(0, retry.attempts - 1)));
  save(store, row, {...retry, notBefore});
  return notBefore - now;
}
