import type Database from "better-sqlite3";
import { INTAKE_DEFAULT_RETRY_MS } from "./companion-direct-intake-client";
import { legacySigningVerdict, type LegacySigningWord } from "./companion-signing-legacy";

/**
 *: what THIS computer checks before it takes work from the server or signs for a phone is ONE rule, the signed-in account.
 * The server proves the account (the desktop's login session: the intake roads are signed with it); the phone is proved by the QR pairing (the bridge). The home pointer
 * (`oneHome().workStanding`) and the phone's pairing grade (`phoneVouch`) are no longer asked: the first made every computer "not home" once there was no move, the second
 * refused every phone paired before a build that wrote `pairedVia` (scenario 3, "no desktop takes the work I handed over").
 * What is left is local and closed: a session exists on this computer, and the host id of the envelope is this computer's own. Every road that fetches or signs for server-ordered work asks here
 * (the intake clients make no request without `mayTake`). Nothing here sends a request, starts a timer, reads a text or calls a model; the answer is a closed word.
 *
 * What a person sees: a signed-out computer quietly takes nothing (the server says `phone_not_paired`, the phone shows "connect computer"). The ONE trace is a main.log line
 * `[companion-computer-gate] ...` with the closed word, written when the word changes (memory: one string per road), never an id.
 */
export type ComputerRefusal = "signed_out" | "no_host" | "no_device" | "gate_unavailable" | "origin_refused" | "not_registered" | "no_road" | LegacySigningWord;
export type ComputerVerdict = { ok: true } | { ok: false; why: ComputerRefusal };
export type TakeRoad = "take" | "start" | "enroll" | "sign" | "consent";

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

type SessionPort = () => { userId: string } | null;
let testSession: SessionPort | null = null;
/** Test hook (a fake signed-in account). Never used by product code. */
export function __setComputerGateSessionForTest(port: SessionPort | null): void { testSession = port; }
function currentSession(): { userId: string } | null {
  if (testSession) return testSession();
  const { getAuthenticatedSessionBinding } = require("../auth") as typeof import("../auth");   // loaded when asked: the Node entries that import this file never load the app shell
  return getAuthenticatedSessionBinding();
}

/** The account condition only (no phone): a session is signed in on this computer and the host id is this computer's own. The intake sweeps ask this before they load a key or make any request. */
export function computerStanding(hostId: string | null): ComputerVerdict {
  try {
    if (!currentSession()) return { ok: false, why: "signed_out" };
    return hostId !== null ? { ok: true } : { ok: false, why: "no_host" };
  } catch { return { ok: false, why: "gate_unavailable" }; }
}

/** The 5 s sweeps (no new timer) ask the same account condition: there is no pointer to read again, so nothing starts here. */
export function computerStandingForSweep(hostId: string | null): ComputerVerdict { return computerStanding(hostId); }

/** The account condition, and a phone to speak of: may this computer fetch, start or sign for that phone's work. The pairing is what the phone proved by its QR; its grade is not asked. */
export function computerMayServe(deviceId: unknown, hostId: string | null): ComputerVerdict {
  const standing = computerStanding(hostId);
  if (!standing.ok) return standing;
  return typeof deviceId === "string" && deviceId !== "" ? { ok: true } : { ok: false, why: "no_device" };
}

/**
 * The bridge methods where THIS computer signs, for the server, that it will take part in work the server holds (enrollment, a run, a handoff proof, the consent to
 * a continuity or a front transfer): the closed word to throw, or null when it may. The words are the ones the phones already know (`phone_not_paired`, `computer_not_home`).
 */
export function computerSigningRefusal(road: TakeRoad, deviceId: unknown, devBootstrap: boolean, hostId: string | null, env: NodeJS.ProcessEnv = process.env): "phone_not_paired" | "computer_not_home" | null {
  // The account-only door is the one of the server-ordered work road (`AGENTLAS_COMPANION_WORK_V2`, off by default). With it off the signing roads keep the condition they had before this change.
  const verdict = env.AGENTLAS_COMPANION_WORK_V2 === "enabled" ? computerMayServe(devBootstrap ? null : deviceId, hostId) : legacySigningVerdict(devBootstrap ? null : deviceId, hostId);
  noteComputerGate(road, verdict);
  if (verdict.ok && road === "enroll") noteEnrollmentSigned();   // T1-3: the one signal that this computer is about to become known to the service
  if (verdict.ok) return null;
  return verdict.why === "no_device" || verdict.why === "phone_not_paired" ? "phone_not_paired" : "computer_not_home";
}

/**
 * How a taken Work that this computer may not start ENDS. The wait is the existing one (the executor's "start unavailable" retry; after 5 minutes the personal
 * agent is told, `supervisor-work-executor.ts` WORK_START_STALL_MS). The server never expires a claimed Work by itself (`companion-direct-work-expiry.mjs`: only an
 * UNCLAIMED reservation expires), so a computer that is never going to be signed in again would wait for ever. The end is the server's own unclaimed-work
 * time-to-live, one day (`companion-direct-work.mjs` UNRECEIVED_TTL_MS = 24 h), counted from when this computer stored the request: after that a refusal that is
 * not a flicker (`signed_out`, `no_device`, `no_road`) closes the request unstarted ("cancel" - the executor's own cancelled_before_dispatch).
 */
export const TAKEN_WORK_WAIT_ENDS_MS = 24 * 60 * 60 * 1000;
export function startWaitEnded(verdict: ComputerVerdict, storedAtIso: string | null | undefined, now: number = Date.now()): boolean {
  if (verdict.ok) return false;
  if (verdict.why !== "signed_out" && verdict.why !== "no_device" && verdict.why !== "no_road") return false;   // `no_host` / `gate_unavailable` are a read that did not come back: a flicker, never an end
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
    return startWaitEnded({ ok: false, why: "no_road" }, row?.created_at, now) ? "cancel" : null;
  } catch { return null; }
}

/** The front road's end (same function, `startWaitEnded`): the front turn that was stored a day ago and never started is dropped, only when the runtime proves nothing ran. true = dropped. */
export function dropEndedFrontTurn(db: Database.Database, commandId: string, runId: string, verdict: ComputerVerdict, provenNotStarted: (runId: string) => boolean, now: number = Date.now()): boolean {
  try {
    const row = db.prepare("SELECT created_at FROM one_companion_front_turns WHERE command_id=? AND run_id=? AND state='stored'").get(commandId, runId) as { created_at?: string } | undefined;
    if (!row || !startWaitEnded(verdict, row.created_at, now) || !provenNotStarted(runId)) return false;
    return db.prepare("DELETE FROM one_companion_front_turns WHERE command_id=? AND run_id=? AND state='stored'").run(commandId, runId).changes === 1;
  } catch { return false; }   // tried again at the next look
}
