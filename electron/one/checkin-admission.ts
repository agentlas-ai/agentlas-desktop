/**
 * Check-in admission gates. A domain that registers One check-ins (a scheduled personal-agent instruction) may hold them for a
 * tick or refuse their review run, for its own reasons (consent, entitlement). The One scheduler (one/supervisor.ts) knows only
 * this contract: it asks every gate which due check-ins to hold before it fires them, and admits every review run through every
 * gate before it starts. A fix to the scheduler therefore reaches every domain's check-ins alike.
 *
 * A gate lives with its domain and is listed in CHECKIN_ADMISSION_GATES. Loading is lazy so the scheduler's import graph stays
 * its own, in Main and in the daemon alike.
 */

/** The review run must not start; the scheduler settles the request as failed with `reason`. */
export class CheckinAdmissionDenied extends Error {
  constructor(readonly reason: string, options?: { cause?: unknown }) { super(reason, options); }
}
/** The gate cannot answer right now (a service is unreachable). Nothing started and nothing was decided; retry later. */
export class CheckinAdmissionDeferred extends Error {
  constructor(readonly reason: string, options?: { cause?: unknown }) { super(reason, options); }
}

export interface CheckinAdmissionGate {
  /** Check-in ids this gate cannot answer this tick: neither fired nor revoked; the next sweep asks again. */
  heldCheckins(): Promise<readonly string[]>;
  /** Before a review run starts. Resolve to admit; throw CheckinAdmissionDenied or CheckinAdmissionDeferred to stop it. */
  admitReview(runId: string): Promise<void>;
}

/** Each domain's gate, in its own module. */
const CHECKIN_ADMISSION_GATES: ReadonlyArray<() => Promise<CheckinAdmissionGate>> = [
  async () => (await import("../finance/daily-briefing")).FINANCE_DAILY_CHECKIN_GATE,
];

export async function heldCheckinIds(): Promise<string[]> {
  const held: string[] = [];
  for (const load of CHECKIN_ADMISSION_GATES) held.push(...await (await load()).heldCheckins());
  return held;
}

export async function admitCheckinReview(runId: string): Promise<void> {
  for (const load of CHECKIN_ADMISSION_GATES) await (await load()).admitReview(runId);
}
