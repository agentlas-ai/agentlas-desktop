import type { NativeStartDescriptor } from "./native-start-protocol";

/**
 * How the service answers a native start whose run id it may already have taken in this boot (native-invocation-runtime.ts):
 * - "fresh": a run id it has not seen;
 * - "replayed": refused, nothing recorded: the same descriptor again, or a new one while the earlier attempt is still on its way;
 * - "replayed-closed": refused, and recorded as the typed pre-boundary refusal of this reservation, because the earlier attempt's
 *   authority is closed (it ended or never began). Desktop re-arms a refused reservation and sends the run id again; without that row
 * its ledger kept the re-armed reservation pending for the rest of the boot .
 */
export function nativeStartReplay(owned: ReadonlyMap<string, unknown>, known: ReadonlyMap<string, { released: boolean; start: NativeStartDescriptor }>,
  start: NativeStartDescriptor, authorityClosed: (start: NativeStartDescriptor) => boolean): "fresh" | "replayed" | "replayed-closed" {
  const prior = known.get(start.binding.runId);
  if (!owned.has(start.handle) && !prior) return "fresh";
  return !owned.has(start.handle) && prior && (prior.released || authorityClosed(prior.start)) ? "replayed-closed" : "replayed";
}

/**
 * A start this service refused before the start boundary, proven by the ledger (store/invocation-admissions.ts
 * invocationProvenNotStarted), left no run behind: its run id is free again. Desktop retries the same run id (it re-arms the rejected
 * reservation and sends it again), and that retry can now start once the refusal's cause is gone (a conversation busy in the other
 * process, a domain hand-over). Before, the run id stayed taken for the whole boot and every retry was refused as replayed, so an
 * owner's message waited for its two-hour deadline. Only this exact record is released; a newer start of the run id is never touched.
 */
export function releaseRefusedStart(owned: Map<string, unknown>, known: Map<string, unknown>, start: NativeStartDescriptor, record: unknown,
  provenNotStarted: (runId: string) => boolean): boolean {
  if (known.get(start.binding.runId) !== record || !provenNotStarted(start.binding.runId)) return false;
  known.delete(start.binding.runId);
  if (owned.get(start.handle) === record) owned.delete(start.handle);
  return true;
}
