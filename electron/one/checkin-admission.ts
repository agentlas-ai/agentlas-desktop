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

/**
 * Loading a gate registers the host-authored instructions its domain owns (host-checkin-instructions.ts), which the check-in cap
 * exempts. A host calls this before it serves check-in commands, so the exemption never depends on which module was imported first.
 * A failed load is not remembered: the next call tries again.
 */
let gatesLoaded: Promise<void> | undefined;
export function loadCheckinGates(): Promise<void> {
  gatesLoaded ??= (async () => { for (const load of CHECKIN_ADMISSION_GATES) await load(); })().catch(error => { gatesLoaded = undefined; throw error; });
  return gatesLoaded;
}

export async function heldCheckinIds(): Promise<string[]> {
  const held: string[] = [];
  for (const load of CHECKIN_ADMISSION_GATES) held.push(...await (await load()).heldCheckins());
  return held;
}

/** Has shared memory had its first merge in this account's memory store? An unreadable store answers no. */
function sharedOpenHere(): boolean {
  try { return (require("../memory/shared-ids") as typeof import("../memory/shared-ids")).sharedOpenHere((require("../memory/database") as typeof import("../memory/database")).getMemoryDb()); } catch { return false; }
}

export async function admitCheckinReview(runId: string): Promise<void> {
  // The personal agent's write gate (Agentlas 2.0 O-M3b): a sealed computer waits (the move may be cancelled), an away computer is not the home any more.
  const refused = (await import("./home")).oneWriteRefusal();
  if (refused === "one_sealed") throw new CheckinAdmissionDeferred(refused);
  if (refused === "one_away") throw new CheckinAdmissionDenied(refused);
  // the person's shared boundary - said at ANY place, this desktop included - holds a check-in before a model is called for it. `no_proactive` = the agent does not start a conversation
  // (the request is settled, nothing runs); `quiet_hours` = it waits for the window's end (the scheduler asks again at its next sweep). No boundary line with a structure = nothing changes.
  const boundary = sharedOpenHere() ? (await import("./shared-boundary")).readSharedBoundary() : null;   // only once shared memory is open here (I11): before that a check-in is held by what it was held by
  if (boundary?.noProactive) throw new CheckinAdmissionDenied("shared_boundary_no_proactive");
  if (boundary && (await import("./shared-boundary")).quietWindowEnd(boundary, new Date()) !== null) throw new CheckinAdmissionDeferred("shared_boundary_quiet_hours");
  for (const load of CHECKIN_ADMISSION_GATES) await (await load()).admitReview(runId);
}
