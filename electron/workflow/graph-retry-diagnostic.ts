/**
 * Which stopped check explains this run's "no automatic retry".
 *
 * A check can stop more than once in one run (the resumed run's admission stop, then the stop of the same check
 * failing again this time), and two checks can stop in the same run. The diagnostic was kept with `??=`, so the
 * FIRST stop's node and reason survived: a later stop of another check never reached the retry decision (the run
 * kept retrying on a check that cannot change), and the same check's newer reason was shown as its old one.
 *
 * Rule: one entry per check, the newest stop of that check wins; the run's diagnostic is the most recently noted stop
 * whose check is what failed now (`isStoppingFailure`). The functions are pure so Desktop Main, the daemon and the
 * terminal engine (all run `runGraph`) read the same answer.
 */
export interface GraphRetryStop<Reason extends string = string> {
  nodeId: string;
  reasonCode: Reason;
  fingerprint: string | null;
}

export type GraphRetryStopLedger<Reason extends string = string> = Map<string, GraphRetryStop<Reason>>;

/** Record a stop; a newer stop of the same check replaces the older one and counts as the most recent. */
export function noteGraphRetryStop<Reason extends string>(ledger: GraphRetryStopLedger<Reason>, stop: GraphRetryStop<Reason>): void {
  ledger.delete(stop.nodeId);
  ledger.set(stop.nodeId, stop);
}

/** The newest stop noted in this run, whichever check it belongs to (the recovery diagnostic event). */
export function latestGraphRetryStop<Reason extends string>(ledger: GraphRetryStopLedger<Reason>): GraphRetryStop<Reason> | null {
  let latest: GraphRetryStop<Reason> | null = null;
  for (const stop of ledger.values()) latest = stop;
  return latest;
}

/** The newest stop whose check failed in this run with a code an automatic retry cannot change, or null. */
export function selectGraphRetryStop<Reason extends string>(
  ledger: GraphRetryStopLedger<Reason>,
  failureCodeOf: (nodeId: string) => string | undefined,
  isStoppingFailure: (code: string) => boolean,
): GraphRetryStop<Reason> | null {
  let picked: GraphRetryStop<Reason> | null = null;
  for (const stop of ledger.values()) if (isStoppingFailure(failureCodeOf(stop.nodeId) ?? "")) picked = stop;
  return picked;
}
