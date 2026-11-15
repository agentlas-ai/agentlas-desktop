import type Database from "better-sqlite3";
import { oneHome, STANDING_READ_WINDOW_MS } from "./home";
import { INTAKE_DEFAULT_RETRY_MS } from "./companion-direct-intake-client";

/**
 * TR-desktop (contracts/trust-root.md section 3, E1): what THIS computer knows by itself before it takes work from the server or signs for a phone.
 * The server may say "this phone is trusted"; the computer looks once more at two facts only it holds:
 *   1. I am the confirmed home right now (`workStanding`: the pointer names this host and key, writes open, no move, not an unconfirmed claim), and the host id of
 *      the envelope is the host id of that home;
 *   2. the pairing record behind the envelope's `deviceId` is one a screen QR made, or the owner pressed "trust" for (`vouchOf` = eligible).
 * Every road that fetches or signs for server-ordered work asks here, so a road added later that does not ask finds the clients refusing (the intake clients
 * make no request without `mayTake`). Nothing here sends a request, starts a timer, reads a text or calls a model; the answer is a closed word.
 *
 * What a person sees: a computer that is not home, and a phone that was not paired by this computer's own screen, are quietly not served (the server says
 * `phone_not_paired`, the phone shows "connect computer"). The ONE trace is a main.log line `[companion-computer-gate] ...` with the closed word, written when the
 * word changes (memory: one string per road), never an id.
 *
 * Old pairing records (a build from before `pairedVia`): `vouchOf` says `owner_press_needed` - not eligible here. One QR scan makes a new record; the owner's
 * "trust this phone" press (home.ts `requestTrustPhone`) turns the old record into `owner-confirmed` once its confirmation window exists.
 */
export type ComputerRefusal = "not_home" | "home_unconfirmed" | "no_pointer" | "signed_out" | "device_proof_unavailable" | "no_device_key" | "move_in_progress"
  | "host_mismatch" | "phone_not_paired" | "gate_unavailable" | "origin_refused" | "not_registered";
export type ComputerVerdict = { ok: true } | { ok: false; why: ComputerRefusal };
export type TakeRoad = "take" | "start" | "enroll" | "sign" | "consent";

const KNOWN: ReadonlySet<string> = new Set(["not_home", "home_unconfirmed", "no_pointer", "signed_out", "device_proof_unavailable", "no_device_key", "move_in_progress"]);
const lastWord = new Map<TakeRoad, string>();

/** One main.log line per road when its word changes. Closed words only; the map holds three strings at most. */
export function noteComputerGate(road: TakeRoad, verdict: ComputerVerdict): void {
  const word = verdict.ok ? "ok" : verdict.why;
  if (lastWord.get(road) === word) return;
  lastWord.set(road, word);
  if (!verdict.ok) { try { console.info(`[companion-computer-gate] ${road}: not served (${word})`); } catch { /* a log never changes the answer */ } }
}

/**
 * Repair R1 / T1-3 ("the computer asks the service for work every 5 s for ever and is refused every time"): the signed poll of a computer the service does not know (the phone has not enrolled it - `/v2/desktop-registry/*` - or the account's epoch / the phone's
 * grant moved on) is answered 403. Nothing changes by asking again, so the phone's polling is PAUSED until a signal, and never for ever:
 *   - a signal that can change the answer: this computer signs an enrollment (`computerSigningRefusal("enroll")` below - the one way a computer becomes known to the service), a new pairing record of the phone, a new web session, another host / personal-agent id (all part of the key the sweeps build);
 *   - the window that is already in this file's client for a "not now" answer (`INTAKE_DEFAULT_RETRY_MS`, 60 s): the service's own state can change without this computer hearing of it (the phone renews its grant), so the pause ends by itself and ONE probe is made - never a stuck state.
 * An enrollment this computer signed less than that window ago is still on its way to the service (the phone signs, then registers): a refusal inside it is not paused, the sweep keeps its own 5 s pace until the registration lands.
 * Memory only (a restart asks once, then pauses again); entries are pruned when they end, so at most one lives per paired phone and session. Nothing here sends a request, starts a timer or reads a text.
 */
const pollRefusedUntil = new Map<string, number>();
let enrollSignedAt = 0;
export function directPollPaused(key: string, now: number = Date.now()): boolean {
  const until = pollRefusedUntil.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  pollRefusedUntil.delete(key);
  return false;
}
export function noteDirectPollRefused(key: string, now: number = Date.now()): void {
  if (now - enrollSignedAt < INTAKE_DEFAULT_RETRY_MS) return;
  for (const [k, until] of pollRefusedUntil) if (until <= now) pollRefusedUntil.delete(k);
  pollRefusedUntil.set(key, now + INTAKE_DEFAULT_RETRY_MS);
}
/** This computer is signing an enrollment for the service: every pause ends now and a refusal in the next window is not paused. */
export function noteEnrollmentSigned(now: number = Date.now()): void { enrollSignedAt = now; pollRefusedUntil.clear(); }
/** Test hook. */
export function __resetPollRefusalsForTest(): void { pollRefusedUntil.clear(); enrollSignedAt = 0; }

/**
 * Desktop E2E-1 (D3, "nothing happens and nothing is said"): the clients of the take roads refuse a web origin that is not a public https one (`companion_intake_origin_invalid`, the clients' own rule) by THROWING when they are made, and
 * every sweep swallows what its road throws - so a computer whose web address the clients refuse took no work, sent no request and wrote no line. The refusal is a closed word now: the same one-line gate trace as every other refusal
 * (`take: not served (origin_refused)`), written when the word changes. Any other error is not named (it is not a decision of this computer; the next sweep tries again as before). Nothing is asked of the server, nothing is stored.
 */
const ORIGIN_REFUSALS: ReadonlySet<string> = new Set(["companion_intake_origin_invalid", "companion_front_origin_invalid"]);   // the two closed words the clients throw (exact, never matched as text)
export function noteTakeError(road: TakeRoad, error: unknown): void {
  try { if (error instanceof Error && ORIGIN_REFUSALS.has(error.message)) noteComputerGate(road, { ok: false, why: "origin_refused" }); } catch { /* a trace never changes the answer */ }
}

type HomePort = Pick<ReturnType<typeof oneHome>, "workStanding" | "phoneVouch"> & Partial<Pick<ReturnType<typeof oneHome>, "standingReadDue" | "refresh" | "pointerAgeMs" | "pointerUnreadMs">>;
let testHome: HomePort | null = null;
/** Test hook (a gate's own home instance for the roads that call this file without one). Never used by product code. */
export function __setComputerGateHomeForTest(port: HomePort | null): void { testHome = port; }

/** Only the home condition (no phone): the intake sweeps ask this before they load a key or make any request. `home` is for a gate's own instance. */
export function computerStanding(hostId: string | null, home?: HomePort): ComputerVerdict {
  try {
    const standing = (home ?? testHome ?? oneHome()).workStanding();
    if (!standing.ok) return { ok: false, why: KNOWN.has(standing.why) ? standing.why as ComputerRefusal : "not_home" };
    return hostId !== null && standing.hostId === hostId ? { ok: true } : { ok: false, why: "host_mismatch" };
  } catch { return { ok: false, why: "gate_unavailable" }; }
}

/** basis: two read windows - a read that was due and did not come back once (the next one is due a minute later) is a hiccup; two windows without one is a computer that cannot read it. */
const STALE_REFUSAL_WINDOWS = 2;
/**
 * TR-desktop 4 (M1): `computerStanding` for the work SWEEPS (the 5 s ones that already exist; no new timer). The home's pointer is read again only on a signal, so a computer whose first read failed offline (or whose
 * copy is old) used to answer from a pointer that never came / never changed. Here, before the sweep asks the standing: when the home says a read is due (`standingReadDue`: it believes it is the home, and its pointer is
 * missing or older than `STANDING_READ_WINDOW_MS`) ONE read is started (`refresh("sweep")`: it merges with a read in flight and keeps its own 60 s gap, so a failing read is tried once a minute, not every 5 s). The read is not
 * waited for: this sweep answers from what it has, the next sweep from the result. A pointer older than two windows that could not be read again is not "home" either (`no_pointer`: nothing is taken, nothing is loaded).
 * A computer that is not the home, not signed in or mid-move asks nothing (0 requests): `standingReadDue` is false for it.
 */
export function computerStandingForSweep(hostId: string | null, home?: HomePort): ComputerVerdict {
  try {
    const port = home ?? testHome ?? oneHome();
    try { if (port.standingReadDue?.() === true) void port.refresh?.("sweep")?.catch(() => undefined); } catch { /* a read that cannot start changes nothing */ }
    const verdict = computerStanding(hostId, port);
    if (!verdict.ok) return verdict;
    const age = port.pointerAgeMs?.();
    return typeof age === "number" && age >= STANDING_READ_WINDOW_MS * STALE_REFUSAL_WINDOWS ? { ok: false, why: "no_pointer" } : verdict;
  } catch { return { ok: false, why: "gate_unavailable" }; }
}

/** How long this computer has been unable to read the home's pointer (null: not known). */
export function homeUnreadMs(home?: HomePort): number | null {
  try { const ms = (home ?? testHome ?? oneHome()).pointerUnreadMs?.(); return typeof ms === "number" ? ms : null; } catch { return null; }
}

/** The home condition and the pairing behind `deviceId`: may this computer fetch, start or sign for that phone's work. */
export function computerMayServe(deviceId: unknown, hostId: string | null, home?: HomePort): ComputerVerdict {
  const standing = computerStanding(hostId, home);
  if (!standing.ok) return standing;
  try { return typeof deviceId === "string" && (home ?? testHome ?? oneHome()).phoneVouch(deviceId) === "eligible" ? { ok: true } : { ok: false, why: "phone_not_paired" }; }
  catch { return { ok: false, why: "gate_unavailable" }; }
}

/**
 * The bridge methods where THIS computer signs, for the server, that it will take part in work the server holds (enrollment, a run, a handoff proof, the consent to
 * a continuity or a front transfer): the closed word to throw, or null when it may. The methods where the phone talks to this computer directly (chat, `work.admit`
 * of an envelope the phone fetched, receipts, status, cancel) never ask here: a computer that is not the home is still spoken to by the phone over the bridge.
 */
export function computerSigningRefusal(road: TakeRoad, deviceId: unknown, devBootstrap: boolean, hostId: string | null): "phone_not_paired" | "computer_not_home" | null {
  const verdict = computerMayServe(devBootstrap ? null : deviceId, hostId);
  noteComputerGate(road, verdict);
  if (verdict.ok && road === "enroll") noteEnrollmentSigned();   // T1-3: the one signal that this computer is about to become known to the service
  if (verdict.ok) return null;
  return verdict.why === "phone_not_paired" ? "phone_not_paired" : "computer_not_home";
}

/**
 * How a taken Work that this computer may not start ENDS. The wait is the existing one (the executor's "start unavailable" retry; after 5 minutes the personal
 * agent is told, `supervisor-work-executor.ts` WORK_START_STALL_MS). The server never expires a claimed Work by itself (`companion-direct-work-expiry.mjs`: only an
 * UNCLAIMED reservation expires), so a computer that is never going to be the home again would wait for ever. The end is the server's own unclaimed-work
 * time-to-live, one day (`companion-direct-work.mjs` UNRECEIVED_TTL_MS = 24 h), counted from when this computer stored the request: after that a refusal that is
 * not a flicker (`not_home`, `phone_not_paired`) closes the request unstarted ("cancel" - the executor's own cancelled_before_dispatch).
 */
export const TAKEN_WORK_WAIT_ENDS_MS = 24 * 60 * 60 * 1000;
export function startWaitEnded(verdict: ComputerVerdict, storedAtIso: string | null | undefined, now: number = Date.now(), unreadMs?: number | null): boolean {
  if (verdict.ok) return false;
  // TR-desktop 4 (M1): `no_pointer` is a flicker (a read that has not come back yet) and ends nothing - unless no pointer was read for the same whole day (the same 24 hours, not a new number): then the computer is as good as not the home.
  if (verdict.why === "no_pointer") { const unread = unreadMs !== undefined ? unreadMs : homeUnreadMs(); if (typeof unread !== "number" || unread < TAKEN_WORK_WAIT_ENDS_MS) return false; }
  else if (verdict.why !== "not_home" && verdict.why !== "phone_not_paired") return false;
  const at = typeof storedAtIso === "string" ? Date.parse(storedAtIso) : NaN;
  return Number.isFinite(at) && now - at >= TAKEN_WORK_WAIT_ENDS_MS;
}

/**
 * TR-desktop 4 (audit "low 7"): the fourth place a taken Work can sit unstarted. A process with no road of its own to the server for direct work - the background service (it never takes a Work now: `companion-direct-intake-runtime.ts` throws in
 * it), or a Main whose intake did not start - answers the executor's `start` question with nothing (`supervisor.ts companionLifecycle`), so a row an OLDER build took in that process was waited on for ever. It ends the same way after the same
 * day, counted from the same stored time: "cancel" (the executor's own cancelled_before_dispatch), never before the day, never for a status question. A row that does not read, or one younger than a day, answers nothing (waited as before).
 */
export function unservedStartEnd(db: Database.Database, purpose: string, commandId: unknown, now: number = Date.now()): "cancel" | null {
  if (purpose !== "start" || typeof commandId !== "string") return null;
  try {
    const row = db.prepare("SELECT created_at FROM one_supervisor_requests WHERE command_id=?").get(commandId) as { created_at?: string } | undefined;
    return startWaitEnded({ ok: false, why: "not_home" }, row?.created_at, now) ? "cancel" : null;
  } catch { return null; }
}

/** The front road's end (same function, `startWaitEnded`): the front turn that was stored a day ago and never started is dropped, only when the runtime proves nothing ran. true = dropped. */
export function dropEndedFrontTurn(db: Database.Database, commandId: string, runId: string, verdict: ComputerVerdict, provenNotStarted: (runId: string) => boolean, now: number = Date.now(), unreadMs?: number | null): boolean {
  try {
    const row = db.prepare("SELECT created_at FROM one_companion_front_turns WHERE command_id=? AND run_id=? AND state='stored'").get(commandId, runId) as { created_at?: string } | undefined;
    if (!row || !startWaitEnded(verdict, row.created_at, now, unreadMs) || !provenNotStarted(runId)) return false;
    return db.prepare("DELETE FROM one_companion_front_turns WHERE command_id=? AND run_id=? AND state='stored'").run(commandId, runId).changes === 1;
  } catch { return false; }   // tried again at the next look
}
