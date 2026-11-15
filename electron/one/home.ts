/*
 * The personal agent's home — this computer's half of the pointer (Agentlas 2.0 O-M3a).
 * Contracts: docs/Agentlas2.0/contracts/one-home-desktop.md (this file's spec) and one-home-pointer.md (the server). Design: P-memory-algorithm §5.8.0.
 *
 * What this bundle does: read the server's pointer on a signal, keep a device key for this computer, register it after the owner's own
 * sign-in, vouch for a phone's key (only a phone paired by the screen QR, or one the owner pressed "trust" for), say "seen" for claims
 * and registrations, refuse a claim against a living home, and carry the owner through "sign in again". The local state is ALWAYS "legacy":
 * nothing here moves data, seals, packs or imports (that is O-M3b), nothing draws a screen, nothing calls a model.
 *
 * Rules this file keeps (each has a gate in scripts/test-one-home-m3a.cjs):
 *  - The only call before the server has answered the pointer GET with 200 is that GET. No other one-home path, ever, before a 200.
 *  - A pointer answer that is not 200 (404 on an old server, 5xx, 401, 403, 429, timeout, a body that is not a pointer) changes nothing.
 *  - A 503 `device_proof_unavailable` (the server's write switch is closed) ends all writes for the rest of this run.
 *  - No timer and no polling: a read happens on a signal (sign-in restored, owner sign-in, wake, the phone's `check`, the screen's refresh).
 *  - The private key is NOT in the app database (which is copied whole by backups and snapshots): it lives in a host-only file wrapped with
 *    safeStorage (home-key-store.ts). Without safeStorage there is no key and nothing is written in the clear. `meta` holds state, hostId, pub, kid.
 *    The key is never logged, never in an IPC answer, never in a bridge answer. A phone's key and signature are never written anywhere:
 *    memory only, 8 of them, 15 minutes.
 *  - Every `oneHome:*` IPC checks its sender (the owner window's main frame, not an app-control call). The two that pass power (trust a phone, cut a key
 *    off) only REQUEST: they run from the Main-owned confirmation window's own IPC (home-confirm.ts). The confirmation number and the phone's key
 *    material are never given to the owner window.
 *  - `seen` is sent only after the screen says a notice was really put in front of the owner (`oneHome:noticeShown`), never on a read.
 *  - A device or computer `label` from the pointer is untrusted text. This file and its IPC answers are the only readers; it never reaches a
 *    model prompt, a tool result, a notification or a log line (gate: source assertion on who imports this file).
 *  - Signature text is the server's, byte for byte: "agentlas.one-home.v1\n<origin>\n<route>\n<userId>\n<canonical body without sig>".
 *
 * No Electron import at module level: the background service loads this through the same mobile-bridge runtime.
 */
import { httpPostFile, httpPostJsonToFile, requestTimeoutMs } from "./bundle-stream";
import { emitDesktopStoreChange } from "../store/change-bus";
import { homeCauseEnded, onHomeCauseEnded } from "./home-signal";
import { noteServiceReach } from "./companion-delivery-signals";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify } from "node:crypto";
import { screenControlActive, SCREEN_CONTROL_WINDOW_MS } from "./screen-control";
import { createHomeKeyStore, type HomeKeyStore } from "./home-key-store";
import { createConfirmGate, NO_CONFIRM_HOST, type ConfirmHost } from "./home-confirm";
import { createHomeLeftover, type HomeLeftover } from "./home-leftover";
import { cleanLabel, MOVE_ID_RE, readPointer, type PointerView } from "./home-pointer-read";
import { responseWaitDelay, sleepMs } from "./home-response-wait";
import { hardenAtMs, hardenVerdict, tellHardenSoon } from "./home-harden-notice";
import { addOwed, cutVerdict, owedStep, readOwed, revokeAuthority, withoutOwed, type CutOutcome } from "./home-revoke-owed";
import { createHomeMove, type HomeMove, type HomeRecordView, type HomeState, type MoveDeps, type CallOut } from "./home-move";
import { cleanSelection, createHomeMirror, type HomeMirror, type HomeMirrorPorts, type MirrorSignal, type MirrorStorePort, type WaitingDecision, type WaitingList } from "./home-mirror";
import { createMirrorFiles, type MirrorFilesPorts, type SignedAnswer } from "./mirror-files";
import { createServerApps, SERVER_APPS_META_PREFIX, type ServerApps, type ServerAppsPorts } from "./server-apps";

// ───────────────────────── proof primitives (identical to the server's proof.ts) ─────────────────────────

export const PROOF_DOMAIN = "agentlas.one-home.v1";
export const PUB_RE = /^[A-Za-z0-9_-]{43}$/;
export const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
export const KID_RE = /^[A-Za-z0-9_-]{22}$/;
const CLAIM_ID_RE = /^cl_[A-Za-z0-9_-]{24}$/;

/** Sorted-key JSON so both sides produce the same bytes. Plain JSON values only. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((k) => record[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  throw new Error("canonicalJson: unsupported value");
}

export function signedText(origin: string, route: string, userId: string, bodyWithoutSig: Record<string, unknown>): string {
  return `${PROOF_DOMAIN}\n${origin}\n${route}\n${userId}\n${canonicalJson(bodyWithoutSig)}`;
}

export const kidOf = (pub: string): string => createHash("sha256").update(pub, "utf8").digest("base64url").slice(0, 22);

/** The 6-digit number both screens show for a requested key (contracts/one-home-pointer.md §10, v2). `serverValue` = a value the server made. */
export function confirmCode(serverValue: string, pub: string): string {
  const n = createHash("sha256").update(`agentlas.one-home.confirm.v2\n${serverValue}\n${pub}`, "utf8").digest().readUInt32BE(0);
  return String(n % 1_000_000).padStart(6, "0");
}

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export function verifyEd25519(pubRaw: string, text: string, sig: string): boolean {
  try {
    if (!PUB_RE.test(pubRaw) || !SIG_RE.test(sig)) return false;
    const raw = Buffer.from(pubRaw, "base64url");
    if (raw.length !== 32) return false;
    return edVerify(null, Buffer.from(text, "utf8"), createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" }), Buffer.from(sig, "base64url"));
  } catch { return false; }
}

// ───────────────────────── local home record ─────────────────────────

/** `legacy` until a move commits here (receiver: `home`), the sender seals (`sealed`) and leaves (`away`). Contract one-home-move.md §3.1; the extra fields (epoch, homeLabel, seenHomes, move, lastMove) are defined there. */
export type OneHomeLocalState = HomeState;
export type OneHomeRecord = HomeRecordView;
/** The record plus the private key read from the key store (PKCS8 DER, base64url). Lives in memory for the signing call only. */
type KeyedRecord = OneHomeRecord & { privateKey: string; pub: string; kid: string };
/** Marker line: the moment this version first ran. A pairing record without `pairedVia` older than it is an "old record"; a newer one is not. */
const LEGACY_CUTOFF_KEY = "one_home:legacy_cutoff";
const RECORD_KEY = (userId: string): string => `one_home:v1:${userId}`;
/** The record of what the server already has of the personal agent's lines, words and profile (home-mirror.ts header: readers, deletion). */
const MIRROR_KEY = (userId: string): string => `one_mirror:v1:${userId}`;

// ───────────────────────── pointer view (the strict reader lives in home-pointer-read.ts) ─────────────────────────
export { readPointer, cleanLabel, MOVE_ID_RE };

const withoutNonce = (line: Record<string, unknown>): Record<string, unknown> => { const { nonce: _nonce, ...rest } = line; return rest; };
/**
 * A trusted-device line for the owner window: no nonce, and the server's `viaHome` becomes the closed value `desktopWork` (true = the connected desktop of NOW vouched for this key: "can work on the desktop"; false = it did not).
 * A line the server did not say it for gets no value: the screen then keeps what this computer knows of it (`desktopWorkOf`). The window is the owner's own IPC; the phone's `one.home.status` builds its own answer and never carries this.
 */
const deviceView = (line: Record<string, unknown>): Record<string, unknown> => {
  const { nonce: _nonce, viaHome, ...rest } = line;
  return typeof viaHome === "boolean" ? { ...rest, desktopWork: viaHome } : rest;
};
/**
 * trust-root section 3 (H2): a phone can work on the desktop when the connected desktop of NOW vouched for its key. The server's word (`viaHome` true / false) decides when it is there;
 * without it (an older server, or a phone this window paired that has no server line yet) this computer's own record decides, and only while this computer IS the connected desktop: a phone
 * this desktop vouched for earlier is not vouched for by whichever desktop is connected now (a change of connection leaves it in the lower list until it pairs by QR again).
 */
export function desktopWorkOf(vouch: "eligible" | "owner_press_needed" | "not_eligible", viaHome: unknown, livingHome: boolean): boolean {
  if (typeof viaHome === "boolean") return viaHome;
  return vouch === "eligible" && livingHome;
}
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A server line whose cut the owner confirmed and the server has not taken yet: the screen draws it without a button ("revoking, waiting for the server"). Only the owner window's own status carries this; the phone's answer is built elsewhere. */
const revoking = (line: Record<string, unknown>, owed: ReadonlySet<string>): Record<string, unknown> => (typeof line.kid === "string" && owed.has(line.kid) ? { ...line, revoking: true } : line);

// ───────────────────────── dependencies ─────────────────────────

export interface OneHomePairingPort {
  /** `keyKid`: the key line this computer has seen the phone prove (pairing.ts `rememberPhoneKeyKid`); absent / null = none seen yet. */
  listPhoneTrust(): Array<{ deviceId: string; name: string; pairedVia: string | null; issuedAt: string; keyKid?: string | null }>;
  phoneTrustRecord(deviceId: string): { deviceId: string; name: string; pairedVia: string | null; issuedAt: string; keyKid?: string | null } | null;
  confirmOwnerTrust(deviceId: string, legacyCutoffIso: string): "confirmed" | "already" | "not_found" | "not_eligible";
  /** Remember (once per key, on the live record) which key line is this phone's. Returns whether the record carries it now. */
  rememberPhoneKeyKid?(deviceId: string, kid: string): boolean;
}

export interface OneHomeDeps {
  now(): number;
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array | import("node:stream").Readable; duplex?: "half"; signal: AbortSignal }): Promise<{ status: number; headers?: { get(name: string): string | null }; json(): Promise<unknown>; arrayBuffer?(): Promise<ArrayBuffer>; body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null }>;
  /** The signed-in desktop account, or null (signed out, a managed host, a development run with effects suppressed). */
  session(): { cookie: string; userId: string } | null;
  baseUrl(): string;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  pairing(): OneHomePairingPort | null;
  /** The owner's browser sign-in with `reauth=1`. Only ever called from the owner's [sign in again] press. */
  signInAgain(): Promise<{ signedIn: boolean }>;
  hostId(): string | null;
  /** Something the phone should re-read (the existing snapshot.updated). Called after the owner's trust press and after a phone was disconnected. */
  pairingChanged(): void;
  /** the wait between the reads that follow a decision whose answer never came (default 3 s). A gate sets it small. */
  settleGapMs?: number;
  /** Cuts a phone's pairing credential and its live connection (the settings screen's own revoke). True only when a live record was cut. Absent = a build with no bridge: the unified [Disconnect] then cuts nothing local. */
  revokePhone?(deviceId: string): boolean;
  screenControl(now: number): { active: boolean; via?: string };
  /** A short, text-only name for this computer for the server's device line. May be undefined. */
  computerLabel(): string | undefined;
  /** Where the private key lives (host-only file, safeStorage). */
  keyStore: HomeKeyStore;
  /** The Main-owned confirmation window (none in this build). */
  confirmHost(): ConfirmHost;
  /** The move's stores, directories and engine (home-move.ts). Absent = this process cannot move anything (`move_unavailable`). */
  move?: MoveDeps;
  /** The mirror's stores (home-mirror-real.ts) and the 2.0 switch. Main only: the background service has no device key, so it could not sign a mirror call anyway (`no_store`). */
  mirrorStore?(): MirrorStorePort | null;
  mirrorSwitchOn?(): boolean;
  /** VD: the real ports of the files that come with the mirror (home-mirror-files-real.ts); this file supplies what only it knows (the signed call, whether this computer may take now). Main only. */
  mirrorFilesPorts?(own: { signedLink(id: string): Promise<SignedAnswer>; mayTake(): boolean }): MirrorFilesPorts | null;
  /** DD: what only Main knows for the connected apps of the server (server-apps.ts): which connectors this computer has itself, where a result's files go, where a finished job is told. Main only (the background service has no device key, so it sees no server app). */
  serverAppsExtras?(own: { files(): MirrorFilesPorts extends never ? never : ReturnType<typeof createMirrorFiles> | null }): Pick<ServerAppsPorts, "computerHas" | "files" | "attach"> | null;
}

const PHONE_KEY_MEMORY_MS = 15 * 60_000;
const PHONE_KEY_MEMORY_MAX = 8;
const HELD_ACTION_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MIN_GAP_AUTOMATIC_MS = 60_000;
const MIN_GAP_SIGNAL_MS = 10_000;
const POSSESSION_WINDOW_MS = 5 * 60_000;
const SEEN_IDS_PER_REQUEST = 6;
const STALE_READ_MS = 10 * 60_000;
/** Under this a difference between the two clocks is the round trip, not a wrong clock. */
const CLOCK_TRUST_MS = 2 * 60_000;
/**
 * TR-desktop 4 (M1): how old the pointer this computer last read may be before the work sweeps read it again, and how long a computer that cannot read it at all waits before a taken Work ends.
 * basis: `STALE_READ_MS` above (the personal agent's own rule for the same cache, `staleKick`). The server needs no tighter window: a signed poll or a signing call of a computer that is not the home is
 * refused by the server itself (web companion-direct-work-auth.mjs `findTarget` -> `computerIsHomeTarget`), so an old copy can neither take a Work nor look "on".
 */
export const STANDING_READ_WINDOW_MS = STALE_READ_MS;

export type OneHomeSignal = "screen" | "phone" | "login" | "restore" | "wake" | "turn" | "sweep" | "request";

interface HeldAction { actionId: string; kind: "register" | "move"; userId: string; createdAt: number; retried: boolean; /** The held move step to run again after the owner signed in again. */ retry?: () => Promise<{ ok: boolean; code?: string }> }
interface PhoneKeyMemory { pub: string; kid: string; at: number }

/** `kid`: signed by a device key (`kid` in the body). `intro`: names its own key (no host id). `host`: `{ hostId, ts, nonce, sig, ...}` signed by this computer's key (every `move/*` route, `claim/receive`). */
type WriteMode = "kid" | "intro" | "host";
type WriteOutcome = CallOut;

export type BridgeRefusal = { ok: false; code: string; [key: string]: unknown };

// ───────────────────────── the home ─────────────────────────

/** A process without the move's stores (the background service): every move call answers `move_unavailable`, nothing is read or written. */
const UNAVAILABLE_MOVE: MoveDeps = new Proxy({} as MoveDeps, { get: () => () => { throw new Error("move_unavailable"); } });

export function createOneHome(deps: OneHomeDeps) {
  // Memory only. Everything below is dropped on sign-out and on a change of account (reset()).
  let cache: { userId: string; pointer: PointerView; readAt: number } | null = null;
  let cacheUser: string | null = null;
  /** TR-desktop 4 (M1): when a pointer was last read (or handed back by a signed answer), or when this process began / the account changed while none was: memory only, one number. */
  let lastGoodReadAt = deps.now();
  /** TR-desktop 4: the HTTP status the last pointer read was answered with (0: no answer at all, a failed connection). A 404 is the server's answer, not a failure: it is asked again after a window. */
  let lastReadStatus = 0;
  /** The server's clock minus this computer's (ms), 0 when they agree or none was read (see `noteServerClock`). Memory only, gone with `reset()`. */
  let clockOffsetMs = 0;
  /** Repair 5: what was last announced on the store-change bus (`one-home`); memory only, one string, gone with `reset()` (an account change). */
  let homeSig: string | null = null;
  let inFlight: Promise<boolean> | null = null;
  let lastAttemptAt = 0;
  let writesClosed = false;
  /** Audit 62 / the transfer in progress (memory only, gone when it ends): what the screen shows as "sent X of Y". */
  let transfer: { phase: "upload" | "download"; done: number; total: number | null; since: number } | null = null;
  /** The last pointer GET answered 404 (a server that rolled the routes back): nothing is signed or sent until a 200 comes. Memory only. */
  let pointerGone = false;
  let held: HeldAction | null = null;
  let reauthRunning = false;
  /** Screens ga-1: the review window of what waits (contracts/mirror-trust.md section 4). Memory only, counts and one closed word, never a text: what the window's answers did so far (for the line on the personal agent screen) and whether the last read of the list could not reach the server. Gone with `reset()`. */
  let review: { epoch: number; userId: string; accepted: number; declined: number; newer: number; cut: number; touched: boolean; at: number } | null = null;
  let waitingFailed: "server_unreachable" | null = null;
  const sentSeen = new Set<string>();
  const handledClaims = new Set<string>();
  let blocked: Array<{ claimId: string; kind: string }> = [];
  /**
   * what the owner's own SUCCESSFUL [Revert] / [This wasn't me] left behind, for the one completion card on the main window ("Connection restored" / "Request declined": sign out of all devices on the web account page).
   * Memory only (nothing is stored: it is gone after a restart), one value (the later answer replaces the earlier one), cleared with the account. `id` only counts answers; the window remembers which id it already drew.
   * Nobody reads it but the window's status read, and it is written only where a signed answer came back ok (a failure, an expiry, a cancel and a local-only close leave it as it was).
   */
  let ownerAnswer: { id: number; kind: "restored" | "declined" } | null = null;
  let ownerAnswerSeq = 0;
  function noteOwnerAnswer(kind: "restored" | "declined"): void { ownerAnswer = { id: ++ownerAnswerSeq, kind }; }
  /** The web account page (where [Sign out of all devices] is): this deployment's own web address, no account id, token or query. Absent when the address cannot be read. */
  function accountUrl(): string | undefined { try { const base = deps.baseUrl(); return /^https?:\/\//.test(base) ? `${base.replace(/\/$/, "")}/account` : undefined; } catch { return undefined; } }
  const phoneKeys = new Map<string, PhoneKeyMemory>();
  const checkSeenAt = new Map<string, number>();
  const confirm = createConfirmGate({ now: () => deps.now(), host: () => deps.confirmHost(), screenControl: (now) => deps.screenControl(now) });

  /** Sign-out and a change of account (desktop C item 6): the plaintext copies a receiving machine unpacked for the account that LEFT go (they are fetched again by design; the record, the keys and the sender's pack folder stay). Best effort, never throws. */
  function leaveAccount(userId: string | null): void {
    if (!userId) return;
    clearResponseWait();
    ownerAnswer = null;
    try { mover.dropPlaintext(userId); } catch { /* none */ }
    try { leftover.dropPlaintext(userId); } catch { /* none */ }
  }
  /** Another account was seen: the key cuts the owner confirmed in the earlier one are not carried to it (home-revoke-owed.ts). */
  function leaveAccountOwed(userId: string | null): void { if (userId) dropOwed(userId, (loadRecord(userId)?.revokeOwed ?? []).map((o) => o.kid)); }
  function reset(): void {
    clearResponseWait();
    clearDeadline();
    cache = null; cacheUser = null; homeSig = null; lastAttemptAt = 0; writesClosed = false; pointerGone = false; held = null; reauthRunning = false; lastGoodReadAt = deps.now(); lastReadStatus = 0; clockOffsetMs = 0;
    sentSeen.clear(); handledClaims.clear(); blocked = []; ownerAnswer = null; phoneKeys.clear(); checkSeenAt.clear(); keyCache.clear(); confirm.reset(); review = null; waitingFailed = null;
    try { mirror.reset(); } catch { /* the mirror is built after this function; nothing to reset before it exists */ }
    try { serverApps?.reset(); } catch { /* built after this function too */ }
  }

  /** The signed-in account; a different account than the one the memory belongs to wipes the memory first. */
  function account(): { cookie: string; userId: string } | null {
    const session = deps.session();
    // Audit 61 (desktop 9): a session that reads as null ONCE (a cookie read that failed for a moment, a token being renewed) is not a sign-out: the plaintext copies stay (the server hands an old record out only a few times, so a copy removed on a flicker may
    // not come again). They go on a real sign-out (`signedOut`, from auth.ts's `signOut`) and when another account is seen (below). The memory state (pointer cache, held actions) is dropped as before: it is read again.
    if (!session) { if (cacheUser !== null || held || phoneKeys.size) reset(); return null; }
    if (cacheUser !== null && cacheUser !== session.userId) { leaveAccount(cacheUser); leaveAccountOwed(cacheUser); reset(); }
    return session;
  }

  /**
   * The server says whether it takes device-proof writes: pointer `writes` is "open" or "closed" (absent = not open). Anything but "open" means this computer makes no key, registers nothing,
   * signs nothing and calls no write route: the answer is the machine code `device_proof_unavailable`. (`stored` — whether the account's pointer document exists — is read by nobody here.)
   */
  const writesOpen = (): boolean => !writesClosed && !pointerGone && cache?.pointer.writes === "open";
  const origin = (): string => new URL(deps.baseUrl()).origin;
  const endpoint = (path = ""): string => `${deps.baseUrl().replace(/\/$/, "")}/api/desktop/one-home${path}`;

  // ── local record (app DB meta: state, hostId, pub, kid — never the private key) ──
  const keyCache = new Map<string, { privateKey: string; pub: string; kid: string }>();
  /** The row never holds a private key. A record is written whole; the key material cache is not touched by a state change. */
  /** Repair 5: a window that has been in front the whole time must learn that the home changed (a move ended, another computer took the home) without waiting for the next focus. The bus carries only the entity; the window re-reads the status.
   * Announced only when the facts a screen shows differ from the last announcement (state, epoch, the computer the pointer names, whether a move exists, the last move's end): the first reading of a run is the baseline, not a change. */
  function announceHome(userId: string): void {
    try {
      const record = loadRecord(userId); const pointer = cache && cache.userId === userId ? cache.pointer : null;
      const sig = [record?.state ?? "legacy", record?.epoch ?? "", pointer ? `${pointer.home.kind}:${pointer.home.kind === "desktop" ? pointer.home.hostId : ""}:${pointer.epoch}:${pointer.homeTrust}` : "", record?.move ? "m" : "", record?.lastMove ? `${record.lastMove.moveId}:${record.lastMove.outcome}` : "", (record?.revokeOwed ?? []).map((o) => o.kid).join(",")].join("|");
      if (sig === homeSig) return;
      const first = homeSig === null; homeSig = sig;
      if (!first) emitDesktopStoreChange({ entity: "one-home" });
    } catch { /* a notice never changes the write or the read */ }
  }
  /**
   * AO: 7 days before an unconfirmed connection confirms itself, the owner is told once on this computer (home-harden-notice.ts has the rule). Called each time a pointer was just taken into memory: no timer.
   * Only the connected desktop itself tells (it is the one whose screen shows "this desktop · not confirmed" with the buttons the notice leads to). Never throws.
   */
  function checkHardenNotice(userId: string): void {
    try {
      const record = loadRecord(userId); const pointer = cache && cache.userId === userId ? cache.pointer : null;
      if (!record || !pointer) return;
      const unconfirmedHere = record.state === "home" && pointer.home.kind === "desktop" && pointer.home.hostId === record.hostId && !!record.pub && pointer.pub === record.pub && pointer.homeTrust === "unconfirmed";
      const hardenAt = unconfirmedHere && isRecord(pointer.trustInfo) ? hardenAtMs(pointer.trustInfo.hardenAt) : null;
      const now = serverNow();
      const verdict = hardenVerdict({ unconfirmedHere, hardenAt, now, told: record.hardenTold });
      if (verdict === "clear") { const { hardenTold: _gone, ...rest } = record; void _gone; writeRecord(userId, rest); }
      else if (verdict === "tell" && hardenAt !== null && tellHardenSoon({ hardenAt, now })) writeRecord(userId, { ...record, hardenTold: hardenAt });
    } catch { /* a notice never changes the read */ }
  }
  const writeRecord = (userId: string, record: OneHomeRecord): void => { deps.setMeta(RECORD_KEY(userId), JSON.stringify({
    state: record.state, hostId: record.hostId, ...(record.pub ? { pub: record.pub } : {}), ...(record.kid ? { kid: record.kid } : {}),
    ...(record.epoch !== undefined ? { epoch: record.epoch } : {}), ...(record.homeLabel ? { homeLabel: record.homeLabel } : {}),
    ...(record.seenHomes?.length ? { seenHomes: record.seenHomes.slice(-8) } : {}), ...(record.move ? { move: record.move } : {}), ...(record.lastMove ? { lastMove: record.lastMove } : {}),
    ...(record.beforeMove ? { beforeMove: record.beforeMove } : {}),
    ...(record.leftover ? { leftover: record.leftover } : {}), ...(record.leftoverBox ? { leftoverBox: record.leftoverBox } : {}), ...(record.leftoverDone ? { leftoverDone: record.leftoverDone } : {}),
    ...(record.leftoverWork ? { leftoverWork: record.leftoverWork } : {}), ...(record.leftoverOk ? { leftoverOk: record.leftoverOk } : {}),
    ...(record.hardenTold !== undefined ? { hardenTold: record.hardenTold } : {}),
    ...(record.revokeOwed?.length ? { revokeOwed: record.revokeOwed } : {}),
  })); announceHome(userId); };

  function loadRecord(userId: string): OneHomeRecord | null {
    try {
      const raw = deps.getMeta(RECORD_KEY(userId));
      if (!raw) return null;
      const value = JSON.parse(raw) as unknown;
      if (!isRecord(value) || typeof value.hostId !== "string") return null;
      const state = value.state === "home" || value.state === "sealed" || value.state === "away" ? value.state : "legacy";
      const seen = Array.isArray(value.seenHomes) ? value.seenHomes.filter((h): h is { hostId: string; pub: string } => isRecord(h) && typeof h.hostId === "string" && typeof h.pub === "string" && PUB_RE.test(h.pub)).slice(-8) : [];
      const record: OneHomeRecord = {
        state, hostId: value.hostId,
        ...(typeof value.pub === "string" && PUB_RE.test(value.pub) ? { pub: value.pub } : {}),
        ...(typeof value.kid === "string" && KID_RE.test(value.kid) ? { kid: value.kid } : {}),
        ...(typeof value.epoch === "number" && Number.isSafeInteger(value.epoch) && value.epoch >= 0 ? { epoch: value.epoch } : {}),
        ...(cleanLabel(value.homeLabel) ? { homeLabel: cleanLabel(value.homeLabel) } : {}),
        ...(seen.length ? { seenHomes: seen } : {}),
        // A move whose id is not the server's id shape is dropped (it would name a folder; B8). A move without an id yet (`claimed`, `requested`, `asked` before the request) is fine.
        ...(isRecord(value.move) && (value.move.role === "receiver" || value.move.role === "sender") && (value.move.moveId === undefined || (typeof value.move.moveId === "string" && MOVE_ID_RE.test(value.move.moveId))) ? { move: value.move as unknown as OneHomeRecord["move"] } : {}),
        ...(isRecord(value.lastMove) ? { lastMove: value.lastMove as unknown as OneHomeRecord["lastMove"] } : {}),
        ...(isRecord(value.beforeMove) && typeof value.beforeMove.chatId === "string" ? { beforeMove: { chatId: value.beforeMove.chatId.slice(0, 128), at: Number(value.beforeMove.at) || 0 } } : {}),
        ...(isRecord(value.leftover) ? { leftover: value.leftover } : {}), ...(isRecord(value.leftoverBox) ? { leftoverBox: value.leftoverBox } : {}),
        ...(Array.isArray(value.leftoverDone) ? { leftoverDone: value.leftoverDone.slice(-16) } : {}), ...(isRecord(value.leftoverWork) ? { leftoverWork: value.leftoverWork } : {}),
        ...(Array.isArray(value.leftoverOk) ? { leftoverOk: value.leftoverOk.slice(-8) } : {}),
        ...(typeof value.hardenTold === "number" && Number.isFinite(value.hardenTold) && value.hardenTold > 0 ? { hardenTold: value.hardenTold } : {}),
        ...(readOwed(value.revokeOwed).length ? { revokeOwed: readOwed(value.revokeOwed) } : {}),
      };
      // An install from before F2 has the private key in this row (development computers only). Move it to the key store on the first read and
      // take it out of the row. Without a usable key store nothing is moved and the row is left as it is: the key is simply not used.
      if (typeof value.privateKey === "string") migrateKeyOut(userId, record, value.privateKey);
      return record;
    } catch { return null; }
  }

  function migrateKeyOut(userId: string, record: OneHomeRecord, privateKey: string): void {
    if (!record.pub || !record.kid || !deps.keyStore.available()) return;
    try {
      if (!deps.keyStore.read(userId) && !deps.keyStore.write(userId, { privateKey, pub: record.pub, kid: record.kid })) return;
      writeRecord(userId, record); // the row is rewritten without the key only after the key is safe
    } catch { /* kept as it was; tried again on the next read */ }
  }

  /** The record with its key from the key store, or null (no record, no key, or no usable safeStorage: this computer then signs nothing). */
  function keyed(userId: string): KeyedRecord | null {
    // The record is read every time (its state changes with a move); only the key material is cached.
    const record = loadRecord(userId);
    if (!record?.pub || !record.kid) return null;
    let key = keyCache.get(userId) ?? null;
    if (!key || key.pub !== record.pub || key.kid !== record.kid) {
      const read = deps.keyStore.read(userId);
      if (!read || read.pub !== record.pub || read.kid !== record.kid) return null;
      key = { privateKey: read.privateKey, pub: read.pub, kid: read.kid };
      keyCache.set(userId, key);
    }
    return { ...record, privateKey: key.privateKey, pub: key.pub, kid: key.kid };
  }

  /**
   * The key of this computer: created the first time it is needed (the registration after the owner's sign-in), then kept in the key store.
   * No usable safeStorage = no key (`key_storage_unavailable`); nothing is created, nothing is written in the clear.
   */
  function ensureKey(userId: string): KeyedRecord | { code: "key_storage_unavailable" | "no_device_key" } {
    const existing = keyed(userId);
    if (existing) return existing;
    if (!deps.keyStore.available()) return { code: "key_storage_unavailable" };
    try {
      const { privateKey } = generateKeyPairSync("ed25519");
      const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
      const material = { privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"), pub, kid: kidOf(pub) };
      if (!deps.keyStore.write(userId, material)) return { code: "key_storage_unavailable" };
      const prior = loadRecord(userId);
      const record: OneHomeRecord = { ...(prior ?? {}), state: prior?.state ?? "legacy", hostId: prior?.hostId ?? deps.hostId() ?? `host_${randomBytes(16).toString("hex")}`, pub, kid: material.kid };
      writeRecord(userId, record);
      keyCache.set(userId, material);
      return { ...record, ...material };
    } catch { return { code: "no_device_key" }; }
  }

  /** The old-record box key (the home's long-lived X25519 seed, beside the device key) goes: a computer that left the home, or whose account slot is forgotten, must not keep the half that opens records locked to it (F-14). */
  function dropHomeBox(userId: string): void { try { deps.move?.leftover?.boxSecret.remove(userId); } catch { /* best effort: the next transition tries again */ } }
  /** The account slot is forgotten: the row and the key file go. (Sign-out keeps both.) Nothing calls this yet; the slot-deletion path will. */
  function forgetAccountSlot(userId: string): void {
    keyCache.delete(userId);
    if (deps.move) { try { mover.sweep(userId, null); } catch { /* the sweep runs again at the next pass of another move */ } }
    dropHomeBox(userId);
    try { deps.move?.leftover?.boxSecret.removeKrej(userId); } catch { /* best effort */ }
    deps.keyStore.remove(userId);
    try { deps.setMeta(RECORD_KEY(userId), ""); } catch { /* the row is empty or unreadable either way */ }
    try { mirror.forget(userId); } catch { /* the record of what the server has is empty or unreadable either way */ }
    try { serverApps?.forget(userId); } catch { /* the stored list is empty or unreadable either way */ }
  }

  const signWith = (privateKey: string, text: string): string =>
    edSign(null, Buffer.from(text, "utf8"), createPrivateKey({ key: Buffer.from(privateKey, "base64url"), format: "der", type: "pkcs8" })).toString("base64url");

  // ── the server's clock ──
  /**
   * The server's "now": the top-level `serverTime` (ISO) of a pointer answer when it has one (every 2xx one does); only when it does not (an older server, an error answer) the `Date` header. One number in memory
   * (server time minus this computer's), 0 until an answer and for a difference under two minutes (round trip and rounding are not a wrong clock). Gone with `reset()`.
   */
  function noteServerClock(serverTime: unknown, header: string | null): void {
    const fromBody = typeof serverTime === "string" && /^\d{4}-\d{2}-\d{2}T/.test(serverTime) ? Date.parse(serverTime) : NaN;   // an ISO stamp only: a bare year or a word is not a clock
    const at = Number.isFinite(fromBody) ? fromBody : header ? Date.parse(header) : NaN;
    if (!Number.isFinite(at)) return;
    const diff = at - deps.now();
    clockOffsetMs = Math.abs(diff) < CLOCK_TRUST_MS ? 0 : diff;
  }
  /** The time the server counts by: this computer's clock when it agrees with the server's, the server's when it does not (a computer whose clock is wrong must not tell "7 days" on the wrong day). */
  const serverNow = (): number => deps.now() + clockOffsetMs;

  // ── transport ──
  async function request(method: "GET" | "POST", url: string, cookie: string, body?: Record<string, unknown>, waitMs: number = REQUEST_TIMEOUT_MS): Promise<{ status: number; body: Record<string, unknown> | null } | null> {
    try {
      const res = await deps.fetch(url, {
        method,
        headers: { cookie, "x-agentlas-client": "desktop", accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(waitMs),
      });
      const parsed = await res.json().catch(() => null);
      noteServerClock(isRecord(parsed) ? parsed.serverTime : undefined, res.headers?.get?.("date") ?? null);
      return { status: res.status, body: isRecord(parsed) ? parsed : null };
    } catch { return null; }
  }

  function adoptPointer(userId: string, value: unknown): void {
    const pointer = readPointer(value);
    if (pointer) { cache = { userId, pointer, readAt: deps.now() }; lastGoodReadAt = deps.now(); cacheUser = userId; announceHome(userId); checkHardenNotice(userId); }
  }

  /**
   * One signed POST. Refuses to leave the process unless the server has already answered the pointer GET with 200 for this account,
   * the server's write switch has not been seen closed this run, and a key exists. `ts` and `nonce` are new on every call.
   */
  async function post(route: string, mode: WriteMode, fields: Record<string, unknown>, session: { cookie: string; userId: string }, record: KeyedRecord, waitMs?: number): Promise<WriteOutcome> {
    if (!cache || cache.userId !== session.userId) return { ok: false, code: "one_home_unavailable" };
    if (writesClosed) return { ok: false, code: "one_home_unavailable" };
    if (cache.pointer.writes !== "open") return { ok: false, code: "device_proof_unavailable" };
    const head = { ts: deps.now(), nonce: randomBytes(16).toString("base64url") };
    const unsigned = mode === "kid" ? { kid: record.kid, ...head, ...fields } : mode === "host" ? { hostId: record.hostId, ...head, ...fields } : { ...head, ...fields };
    const sig = signWith(record.privateKey, signedText(origin(), route, session.userId, unsigned));
    const answer = await request("POST", endpoint(`/${route}`), session.cookie, { ...unsigned, sig }, waitMs);
    if (!answer) return { ok: false, code: "server_unreachable", unreachable: true };
    const body = answer.body;
    if (answer.status >= 200 && answer.status < 300 && body?.ok === true) {
      adoptPointer(session.userId, body.pointer);
      return { ok: true, result: typeof body.result === "string" ? body.result : "done", body };
    }
    const code = typeof body?.error === "string" ? body.error : "failed";
    if (answer.status === 503 && code === "device_proof_unavailable") writesClosed = true; // one try; no more writes this run
    else if (body?.pointer) adoptPointer(session.userId, body.pointer); // a 409 carries the pointer: the next read is free
    return { ok: false, code, status: answer.status, ...(body?.retryable === true ? { retryable: true } : {}), body };   // body carries `limit` ("window" | "count"), `retryAfterSeconds`, `reason` (fence_refused) for the caller
  }

  // ── reading the pointer ──
  async function readOnce(session: { cookie: string; userId: string }): Promise<boolean> {
    const answer = await request("GET", endpoint(), session.cookie);
    lastReadStatus = answer ? answer.status : 0;
    // direct-work-capacity R8: the server answering after it had not is the one signal that sends a waiting receipt again (a change only, never every read).
    noteServiceReach(!!answer && answer.status < 500);
    // Anything but a 200 with a pointer: nothing changes, nothing is shown, no retry. A 404 is remembered (memory only) so that a sealed sender can open itself; a 200 clears it.
    if (answer && answer.status === 404 && cacheUser === session.userId) { pointerGone = true; if (deps.move && loadRecord(session.userId)?.state === "sealed") void mover.drive().catch(() => undefined); }
    if (!answer || answer.status !== 200 || answer.body?.ok !== true) return false;
    const pointer = readPointer(answer.body.pointer);
    if (!pointer) return false;
    if (cacheUser !== session.userId) { leaveAccount(cacheUser); leaveAccountOwed(cacheUser); reset(); }
    pointerGone = false;
    // Audit 62 (home D3): the server that answers a pointer with `writes: "open"` takes writes: a 503 seen before (the switch was shut for a moment) is not held against it until the app is started again.
    if (pointer.writes === "open") writesClosed = false;
    cache = { userId: session.userId, pointer, readAt: deps.now() }; lastGoodReadAt = deps.now(); cacheUser = session.userId; announceHome(session.userId); checkHardenNotice(session.userId);
    await afterRead(session, pointer);
    kickMirror();
    return true;
  }

  /** One pointer GET per signal. Never retried, never on a timer. */
  async function refresh(signal: OneHomeSignal): Promise<{ ok: boolean; result: "read" | "coalesced"; code?: string }> {
    const session = account();
    if (!session) return { ok: false, result: "coalesced", code: "sign_in_required" };
    if (inFlight) { const done = await inFlight; return { ok: done, result: "coalesced", ...(done ? {} : { code: "one_home_unavailable" }) }; }
    const gap = signal === "request" ? 0 : signal === "restore" || signal === "wake" || signal === "sweep" ? MIN_GAP_AUTOMATIC_MS : MIN_GAP_SIGNAL_MS;   // "request" is the response wait's own read (home-response-wait.ts): its interval is the gap
    if (lastAttemptAt && deps.now() - lastAttemptAt < gap) return { ok: cache?.userId === session.userId, result: "coalesced", ...(cache?.userId === session.userId ? {} : { code: "one_home_unavailable" }) };
    lastAttemptAt = deps.now();
    lastReadSignal = signal;
    readFromNothing = !(cache && cache.userId === session.userId) || pointerGone;
    const flight = readOnce(session).catch(() => false);
    inFlight = flight;
    try { const done = await flight; return { ok: done, result: "read", ...(done ? {} : { code: "one_home_unavailable" }) }; }
    finally { if (inFlight === flight) inFlight = null; }
  }

  // ── a signed decision whose ANSWER never came ──
  /**
   * [Connect here], [Revert] and [Yes, it was me] are one signed call each, and this computer gives the answer 8 seconds. A server that is slow (pair test 10: 10.8 s) or a connection that is cut leaves the owner with a
   * "That did not work" for a decision the server then made. Such a call is not told as a failure before the pointer says so: it is read again (`reads` times, `deps.settleGapMs` apart, 3 s by default) and `stands` says
   * whether what the pointer shows is the result the owner asked for. Only a call that got NO answer (`unreachable`) or the server's own "this computer is already the home" comes here; every other refusal is the server's no.
   */
  const SETTLE_GAP_MS = 3_000;
  const noAnswer = (out: WriteOutcome): boolean => !out.ok && out.unreachable === true;
  async function settledByPointer(session: { cookie: string; userId: string }, stands: () => boolean, reads: number): Promise<boolean> {
    for (let i = 0; i < reads; i += 1) {
      if (i > 0) await sleepMs(deps.settleGapMs ?? SETTLE_GAP_MS);
      await readOnce(session).catch(() => false);
      if (account()?.userId === session.userId && stands()) return true;
    }
    return false;
  }
  const SETTLE_READS = 3;

  /** What to do with a pointer just read: refuse claims against a living home, then say "seen". One call each, same ids never twice per run. */
  async function afterRead(session: { cookie: string; userId: string }, pointer: PointerView): Promise<void> {
    // Audit 59 B6: a sealed sender whose server shut the writes gets its pass anyway (nothing is sent: the pass opens its own door, locally).
    const kickSealed = (): void => { if (deps.move && loadRecord(session.userId)?.state === "sealed") void mover.drive().catch(() => undefined); };
    if (writesClosed) { kickSealed(); return; }
    if (pointer.writes !== "open") { reconcile(session.userId, pointer); kickSealed(); return; }   // the local record still follows a committed epoch; nothing is signed or sent
    const record = keyed(session.userId);
    if (!record) { reconcile(session.userId, pointer); return; } // a computer with no key makes no signed call at all - but it still learns that its home left (F-7: the record is local state, not a signature)
    const living = isLivingHome(record, pointer);
    if (living) {
      for (const claim of pointer.claims) {
        const claimId = typeof claim.claimId === "string" ? claim.claimId : "";
        const kind = typeof claim.kind === "string" ? claim.kind : "";
        const to = isRecord(claim.to) ? claim.to : null;
        if (!CLAIM_ID_RE.test(claimId) || handledClaims.has(claimId)) continue;
        if (kind !== "takeover" && kind !== "rekey" && kind !== "to-server") continue; // "receive" is a claim on a server home
        if (to && to.pub === record.pub) continue; // a request this computer made itself
        handledClaims.add(claimId);
        const out = await post("claim/reject", "kid", { claimId }, session, record);
        if (out.ok || (!out.ok && out.code === "claim_not_found")) blocked = [...blocked, { claimId, kind }].slice(-8);
        else if (out.unreachable || (typeof out.status === "number" && out.status >= 500)) handledClaims.delete(claimId);   // (home X2): a server that was down is not a decision: the next read tries this refusal again (it used to ripen for the rest of the run)
        if (writesClosed) return;
      }
    }
    // No `seen` here (F3): reading a pointer is not putting a notice in front of the owner. `noticeShown` sends it, only when the screen says so.
    reconcile(session.userId, pointer);
    if (deps.move) { void mover.drive().catch(() => undefined); if (deps.move.leftover) void leftover.drive().catch(() => undefined); }
    await settleOwed(session, pointer, record).catch(() => undefined);   // the server answered this read: the key cuts the owner already confirmed are tried once
  }

  /**
   * Local state changes only with a COMMITTED epoch (design 5.8.3): another computer's pending request changes nothing here. A living home that the pointer no longer names is `away`
   * (nothing is deleted); an `away` computer that a revert made the home again is `home`; the epoch of a home that is still the home is kept up to date.
   */
  function reconcile(userId: string, pointer: PointerView): void {
    const record = loadRecord(userId);
    if (!record) return;
    const mine = pointer.home.kind === "desktop" && pointer.home.hostId === record.hostId && !!record.pub && pointer.pub === record.pub;
    const last = isRecord(pointer.last) ? pointer.last : null;
    let next: OneHomeRecord | null = null;
    if ((record.state === "home" || record.state === "sealed") && record.epoch !== undefined && pointer.epoch > record.epoch && !mine && !(record.move?.role === "sender" && record.move.step !== "asked")) {
      const label = pointer.home.kind === "desktop" ? cleanLabel(pointer.home.label) : undefined;
      const { leftoverBox: _box, ...keep } = record;       // a computer that is not the home keeps no old-record box key (F-14)
      next = { ...keep, state: "away", epoch: pointer.epoch, ...(label ? { homeLabel: label } : {}) };
      dropHomeBox(userId);
    } else if (record.state === "away" && mine && record.epoch !== undefined && pointer.epoch > record.epoch && last?.mode === "revert" && !record.move) {
      const { homeLabel: _l, ...rest } = record;
      next = { ...rest, state: "home", epoch: pointer.epoch };
    } else if (record.state === "home" && mine && record.epoch !== pointer.epoch && !record.move) {
      next = { ...record, epoch: pointer.epoch };
    } else if ((record.state === "legacy" || record.state === "away" || record.state === "sealed") && mine && last?.mode === "takeover" && pointer.epoch > (record.epoch ?? -1)) {
      // "Start here" took effect (the claim was approved, or the wait ended): this computer is the home, empty or with the copy that was only sealed and never taken (a sealed copy opens again).
      // The record's own home fields of a past life (the label of the home it left, the open move) go; the data on this computer is not touched.
      const { homeLabel: _l, beforeMove: _b, ...rest } = record;
      next = { ...rest, state: "home", epoch: pointer.epoch };
      // A move that was in flight (the sealed copy that was never taken) ends here: its pack folder and secrets go with closeMove, which also writes `lastMove`.
      if (record.move && deps.move) { writeRecord(userId, next); mover.syncMirror(next); void mover.closeMove(userId, "stopped", "takeover").catch(() => undefined); next = null; }
    }
    // a receiving move that had already committed (this computer WAS the home, importing or waiting for the owner's confirmation) ends with the home it was bringing in: the home went away from this computer (a revert, another claim), so what it waits for
    // can never come. Left open it showed "moving" with no button for up to the move's own end (7 days). The code says which end it was; the data already imported stays (this computer is `away`, its chats read-only, as for any computer that is not the home).
    const endsReceiver = !!next && next.state === "away" && record.state === "home" && record.move?.role === "receiver" && !!deps.move;
    // Mirror order by direction: closing (`away`, `sealed`) writes the engine mirror first, opening (`home`) writes the record first.
    if (next) {
      const closing = next.state === "away" || next.state === "sealed";
      if (closing && deps.move) mover.syncMirror(next);
      writeRecord(userId, next);
      if (!closing && deps.move) mover.syncMirror(next);
      if (endsReceiver) void mover.closeMove(userId, "stopped", last?.mode === "revert" ? "reverted" : "home_changed").catch(() => undefined);
    }
    // A request of another computer against this living home is only NOTED (`asked`): nothing is sealed, packed or sent until the owner presses [move] or a trusted phone approves.
    if (deps.move) mover.noteIncoming(userId, pointer);
  }

  /** `one_sealed` / `one_away` when this computer's personal agent must not write (the write gate, contract §3.2). `legacy` and `home` pass. Cheap: one meta row. */
  function writeRefusal(): "one_sealed" | "one_away" | null {
    try {
      const session = deps.session(); if (!session) return null;
      const state = loadRecord(session.userId)?.state;
      return state === "sealed" ? "one_sealed" : state === "away" ? "one_away" : null;
    } catch { return null; }
  }
  /** The 10-minute signal: at the start of a personal-agent turn on a computer that is not `legacy`, one pointer read when the last one is older than 10 minutes. Never waits (the answer is used by the next turn). */
  function staleKick(): void {
    try {
      const session = deps.session(); if (!session) return;
      const rec = loadRecord(session.userId);
      const state = rec?.state;
      // Audit 62 (home D2): a `legacy` computer that has a move record - the RECEIVING side of a move - takes the turn signal too (it waits on the old home, and nothing else wakes it). A `legacy` computer without one reads nothing.
      if (!state || (state === "legacy" && !rec?.move)) return;
      if (cache && cache.userId === session.userId && deps.now() - cache.readAt < STALE_READ_MS) return;
      void refresh("turn").catch(() => undefined);
    } catch { /* a read that cannot start changes nothing */ }
  }

  /**
   * The screen reports that it really showed these claim / registration ids to the owner (Main has checked the window is visible and not
   * minimized). Only then does this computer sign "seen" for them: that is what makes the server count "a notice got through" and shortens
   * the wait. Ids that are not in the pointer just read, or were already sent in this run, are dropped.
   */
  async function noticeShown(ids: unknown): Promise<{ ok: boolean; code?: string; sent?: number }> {
    const session = account();
    if (!session) return { ok: false, code: "sign_in_required" };
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > SEEN_IDS_PER_REQUEST || ids.some((i) => typeof i !== "string" || i.length > 64)) return { ok: false, code: "invalid_args" };
    if (!cache || cache.userId !== session.userId || writesClosed || pointerGone) return { ok: false, code: "one_home_unavailable" };
    if (!writesOpen()) return { ok: false, code: "device_proof_unavailable" };
    if (deps.screenControl(deps.now()).active) return { ok: false, code: "screen_control_active" };   // F-10: a screen that something else is operating did not show a notice to the owner
    const record = keyed(session.userId);
    if (!record) return { ok: false, code: deps.keyStore.available() ? "no_device_key" : "key_storage_unavailable" };
    const known = new Set<string>([
      ...cache.pointer.claims.map((c) => (typeof c.claimId === "string" ? c.claimId : "")),
      ...cache.pointer.pendingDevices.map((d) => (typeof d.kid === "string" ? d.kid : "")),
    ]);
    const batch = [...new Set(ids as string[])].filter((id) => known.has(id) && !sentSeen.has(id));
    if (!batch.length) return { ok: true, sent: 0 };
    for (const id of batch) sentSeen.add(id); // marked when sent: a failure is not retried in this run
    const out = await post("seen", "kid", { ids: batch }, session, record);
    if (!out.ok && (out.unreachable || (typeof out.status === "number" && out.status >= 500))) for (const id of batch) sentSeen.delete(id);   // (home X3): a server that was down did not count the notice: the next report sends it again
    return out.ok ? { ok: true, sent: batch.length } : { ok: false, code: out.code };
  }

  /** "I am the effective home": the record says so AND the confirmed pointer names this host and key. Only a gate's own record makes this true in O-M3a. */
  function isLivingHome(record: OneHomeRecord, pointer: PointerView): boolean {
    return record.state === "home" && pointer.home.kind === "desktop" && pointer.home.hostId === record.hostId && !!record.pub && pointer.pub === record.pub;
  }

  // ── registering this computer's key (after the owner's own sign-in) ──
  function hasLine(pointer: PointerView, kid: string): boolean {
    return pointer.devices.some((d) => d.kid === kid) || pointer.pendingDevices.some((d) => d.kid === kid);
  }

  async function register(interactive: boolean): Promise<{ ok: boolean; result?: string; code?: string; actionId?: string }> {
    const session = account();
    if (!session) return { ok: false, code: "sign_in_required" };
    if (!cache || cache.userId !== session.userId || writesClosed || pointerGone) return { ok: false, code: "one_home_unavailable" };
    if (!writesOpen()) return { ok: false, code: "device_proof_unavailable" };   // no key is made while the server's writes are not open
    const made = ensureKey(session.userId);
    if ("code" in made) return { ok: false, code: made.code };
    const record = made;
    if (hasLine(cache.pointer, record.kid)) return { ok: true, result: "already" };
    const label = deps.computerLabel();
    const out = await post("device/register", "intro", { kind: "desktop", pub: record.pub, ...(label ? { label } : {}) }, session, record);
    if (out.ok) return { ok: true, result: out.result };
    if (out.code === "reauth_required") {
      // Silent (right after a sign-in, nobody asked): do nothing at all. Owner-started: keep this ONE action in memory for the press.
      if (!interactive) return { ok: false, code: "reauth_required" };
      held = { actionId: randomBytes(9).toString("base64url"), kind: "register", userId: session.userId, createdAt: deps.now(), retried: false };
      return { ok: false, code: "reauth_required", actionId: held.actionId };
    }
    return { ok: false, code: out.code };
  }

  /** The owner's browser sign-in just finished: read the pointer, and if it is there and this computer is not on it, register once, quietly. */
  async function afterInteractiveSignIn(): Promise<void> {
    if (reauthRunning) return; // the owner's [sign in again] press carries its own retry
    const first = await refresh("login");
    if (!first.ok) return;
    await register(false);
  }

  // ── "sign in again" ──
  async function reauth(actionId: string): Promise<{ ok: boolean; code?: string }> {
    const action = held;
    if (!action || action.actionId !== actionId) return { ok: false, code: "no_pending_action" };
    if (deps.now() - action.createdAt > HELD_ACTION_MS) { held = null; return { ok: false, code: "action_expired" }; }
    if (account()?.userId !== action.userId) { held = null; return { ok: false, code: "account_changed" }; }
    if (action.retried) { held = null; return { ok: false, code: "reauth_failed" }; }
    reauthRunning = true;
    try {
      let signedIn = false;
      try { signedIn = (await deps.signInAgain()).signedIn; } catch { signedIn = false; }
      if (!signedIn) return { ok: false, code: "reauth_cancelled" }; // the action stays; the owner may press again
      if ((deps.session()?.userId ?? null) !== action.userId) { account(); held = null; return { ok: false, code: "account_changed" }; } // another account (or none) came back: the action is thrown away
      if (held !== action) return { ok: false, code: "no_pending_action" };
      if (deps.now() - action.createdAt > HELD_ACTION_MS) { held = null; return { ok: false, code: "action_expired" }; }
      action.retried = true;
      const out = action.retry ? await action.retry() : await register(false);
      held = null;
      if (out.ok) return { ok: true };
      return { ok: false, code: out.code === "reauth_required" ? "reauth_failed" : out.code };
    } finally { reauthRunning = false; }
  }

  // ── phones ──
  /** The moment this version first ran (written once, at start-up by Main, or the first time it is needed). Read by vouchOf and the owner's press. */
  function legacyCutoff(): string {
    try {
      const existing = deps.getMeta(LEGACY_CUTOFF_KEY);
      if (existing && Number.isFinite(Date.parse(existing))) return existing;
      const stamp = new Date(deps.now()).toISOString();
      deps.setMeta(LEGACY_CUTOFF_KEY, stamp);
      return stamp;
    } catch { return new Date(0).toISOString(); } // no marker readable: nothing counts as an old record
  }
  /** F4: "no value" is only an OLD record — one a build from before pairedVia wrote, older than the cutoff. Any newer record has a value ("unstamped" at worst). */
  const isOldRecord = (r: { pairedVia: string | null; issuedAt: string }): boolean => !r.pairedVia && Date.parse(r.issuedAt) < Date.parse(legacyCutoff());
  function vouchOf(r: { pairedVia: string | null; issuedAt: string } | null | undefined): "eligible" | "owner_press_needed" | "not_eligible" {
    if (!r) return "not_eligible";
    if (r.pairedVia === "screen-qr" || r.pairedVia === "owner-confirmed") return "eligible";
    return !r.pairedVia && isOldRecord(r) ? "owner_press_needed" : "not_eligible";
  }

  function pruneMemory(): void {
    const now = deps.now();
    for (const [id, m] of phoneKeys) if (now - m.at > PHONE_KEY_MEMORY_MS) phoneKeys.delete(id);
    for (const [id, at] of checkSeenAt) if (now - at > MIN_GAP_SIGNAL_MS) checkSeenAt.delete(id);
  }

  /** The server's line for a phone key (the nonce the confirmation number is built from), or null when the key is not registered. */
  function lineFor(kid: string): { nonce: string } | null {
    const pointer = cache?.pointer;
    if (!pointer) return null;
    const line = [...pointer.pendingDevices, ...pointer.devices].find((d) => d.kid === kid);
    return line && typeof line.nonce === "string" && line.nonce ? { nonce: line.nonce } : null;
  }

  /** The key line of a phone: the key it presented in the last 15 minutes, else the one its pairing record remembers. Closed values only (a `kid`); never a name. */
  function phoneKidOf(phone: { deviceId: string; keyKid?: string | null }): string | null {
    return phoneKeys.get(phone.deviceId)?.kid ?? (typeof phone.keyKid === "string" && KID_RE.test(phone.keyKid) ? phone.keyKid : null);
  }
  /** The live pairing record that carries this key line, or null (the server line is then a device this computer did not pair). */
  function phoneOfKid(kid: string): { deviceId: string; name: string } | null {
    return (deps.pairing()?.listPhoneTrust() ?? []).find((phone) => phoneKidOf(phone) === kid) ?? null;
  }

  function stashPhoneKey(deviceId: string, pub: string): void {
    pruneMemory();
    if (!phoneKeys.has(deviceId) && phoneKeys.size >= PHONE_KEY_MEMORY_MAX) {
      const oldest = [...phoneKeys.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) phoneKeys.delete(oldest[0]);
    }
    phoneKeys.set(deviceId, { pub, kid: kidOf(pub), at: deps.now() });
  }

  /**
   * Can the owner be asked to trust this phone, and what would the confirmation window show? No state changes here. The number is computed
   * from the server's nonce for the phone's key and the key itself; it goes to the confirmation window only.
   */
  function prepareTrust(deviceId: string): { ok: true; confirmCode: string; name: string; alreadyEligible: boolean } | { ok: false; code: string } {
    const session = account();
    if (!session) return { ok: false, code: "sign_in_required" };
    const port = deps.pairing();
    const record = port?.phoneTrustRecord(deviceId) ?? null;
    if (!port || !record) return { ok: false, code: "not_found" };
    const vouch = vouchOf(record);
    if (vouch === "not_eligible") return { ok: false, code: "not_eligible" };
    if (deps.screenControl(deps.now()).active) return { ok: false, code: "screen_control_active" };
    pruneMemory();
    const key = phoneKeys.get(deviceId);
    const line = key ? lineFor(key.kid) : null;
    if (!key || !line) return { ok: false, code: "register_first" };
    return { ok: true, confirmCode: confirmCode(line.nonce, key.pub), name: record.name, alreadyEligible: vouch === "eligible" };
  }

  /** The owner pressed "trust" in the confirmation window. Runs from there only (home-confirm.ts). No server call: the phone's proof is five minutes old at most. */
  function commitTrust(deviceId: string, shownCode: string): { ok: boolean; code?: string; confirmCode?: string } {
    const again = prepareTrust(deviceId); // everything is checked again: the screen, the record, the key the number was made from
    if (!again.ok) return { ok: false, code: again.code };
    if (again.confirmCode !== shownCode) return { ok: false, code: "request_changed" };
    if (again.alreadyEligible) return { ok: true, confirmCode: again.confirmCode };
    const outcome = deps.pairing()!.confirmOwnerTrust(deviceId, legacyCutoff());
    if (outcome === "not_found") return { ok: false, code: "not_found" };
    if (outcome === "not_eligible") return { ok: false, code: "not_eligible" };
    try { deps.pairingChanged(); } catch { /* a notice never changes the answer */ }
    return { ok: true, confirmCode: again.confirmCode };
  }

  /** The owner window's request. It checks and asks for the confirmation window; it never runs the press. */
  function requestTrustPhone(deviceId: string): { ok: boolean; code?: string; requestId?: string } {
    const first = prepareTrust(deviceId);
    if (!first.ok) return first;
    return confirm.request("trustPhone", { deviceId, name: first.name, confirmCode: first.confirmCode }, () => commitTrust(deviceId, first.confirmCode));
  }

  /** One signed cut of a key line on the server. The answer carries what `cutVerdict` reads (status, unreachable, retryable), so a wait is told from a refusal by closed values, never by a sentence. */
  async function revokeKey(kid: string): Promise<CutOutcome> {
    const session = account();
    if (!session) return { ok: false, code: "sign_in_required" };
    if (typeof kid !== "string" || !KID_RE.test(kid)) return { ok: false, code: "invalid_args" };
    if (!cache || cache.userId !== session.userId || writesClosed || pointerGone) return { ok: false, code: "one_home_unavailable" };
    if (!writesOpen()) return { ok: false, code: "device_proof_unavailable" };
    const record = keyed(session.userId);
    if (!record) return { ok: false, code: deps.keyStore.available() ? "no_device_key" : "key_storage_unavailable" };
    const out = await post("device/revoke", "kid", { targetKid: kid }, session, record);
    return out.ok ? { ok: true } : { ok: false, code: out.code, ...(typeof out.status === "number" ? { status: out.status } : {}), ...(out.unreachable ? { unreachable: true } : {}), ...(out.retryable ? { retryable: true } : {}) };
  }

  /** May this computer cut `kid` on the server, by the pointer's own lines (home-revoke-owed.ts `revokeAuthority`)? "no" is only said when the pointer proves it. */
  function authorityFor(userId: string, kid: string): "yes" | "no" | "unknown" {
    const record = loadRecord(userId);
    const pointer = cache && cache.userId === userId ? cache.pointer : null;
    if (!record || !pointer) return "unknown";
    return revokeAuthority({ ownKid: record.kid ?? null, livingHome: isLivingHome(record, pointer), homeTrust: pointer.homeTrust, lines: [...pointer.pendingDevices, ...pointer.devices], target: kid });
  }
  /** The owner confirmed this `kid`; the server half could not be done now. Kept in the account's own home record (home-revoke-owed.ts: readers, erasure). False when nothing could be kept. */
  function rememberOwed(userId: string, kid: string): boolean {
    try {
      const record = loadRecord(userId);
      if (!record) return false;
      writeRecord(userId, { ...record, revokeOwed: addOwed(record.revokeOwed ?? [], kid, serverNow()) });
      return true;
    } catch { return false; }
  }
  function dropOwed(userId: string, kids: string[]): void {
    try {
      const record = loadRecord(userId);
      if (!record?.revokeOwed?.length) return;
      const left = withoutOwed(record.revokeOwed, kids);
      if (left.length === record.revokeOwed.length) return;
      const { revokeOwed: _gone, ...rest } = record; void _gone;
      writeRecord(userId, left.length ? { ...rest, revokeOwed: left } : rest);
    } catch { /* the line stays; the next pointer read looks at it again */ }
  }
  /**
   * The pointer was just read: the server answers now. Each owed cut is tried once (home-revoke-owed.ts `owedStep` says which need a call at all). A wait word keeps the rest for the next read and
   * stops this pass (the server is not deciding: no second call to it); done and refused both end the line.
   */
  async function settleOwed(session: { cookie: string; userId: string }, pointer: PointerView, record: OneHomeRecord): Promise<void> {
    const owed = loadRecord(session.userId)?.revokeOwed ?? [];
    if (!owed.length) return;
    const lines = [...pointer.pendingDevices, ...pointer.devices];
    const ended: string[] = [];
    for (const o of owed) {
      const step = owedStep({ owed: o, lines, reconnected: phoneOfKid(o.kid) !== null,
        authority: revokeAuthority({ ownKid: record.kid ?? null, livingHome: isLivingHome(record, pointer), homeTrust: pointer.homeTrust, lines, target: o.kid }) });
      if (step !== "call") { ended.push(o.kid); continue; }
      const verdict = cutVerdict(await revokeKey(o.kid));
      if (verdict === "wait") break;
      ended.push(o.kid);
      if (writesClosed) break;
    }
    if (ended.length) dropOwed(session.userId, ended);
  }

  /**
   * The phone behind a key line is cut as one: its pairing record (the direct connection) and its key on the server. Local first - it needs no network and is what
   * stops the phone at once; then the server's key. The owner confirmed this one `kid`, and the answer says where the server half stands (closed words; the window draws the sentence):
   *   ok                        - both are cut (a key the server no longer has counts as cut).
   *   phone_cut_failed          - the pairing record could not be cut: nothing was done and nothing was sent; the same window may press again (`retry`).
   *   phone_cut_key_waits       - the server did not decide (down, unreachable): the phone is cut, the key is kept in `revokeOwed` and cut by the next successful pointer read - nobody presses again.
   *   phone_cut_key_elsewhere   - the server will not take it from this computer (the pointer proves it, or it refused): the phone is cut here; the key is cut from the connected desktop. Nothing is kept: this computer would be refused every time.
   * A cut with no pairing record behind it (another computer's key line) keeps the server's own word when it was refused.
   */
  async function revokeKeyAndPairing(kid: string, deviceId: string | null): Promise<{ ok: boolean; code?: string; serverCode?: string; retry?: boolean }> {
    const withPairing = !!deviceId && !!deps.revokePhone;   // a build with no bridge has no pairing record to cut: the key alone, as before
    if (withPairing) {
      const cut = deps.revokePhone!(deviceId as string) === true;
      if (!cut && deps.pairing()?.phoneTrustRecord(deviceId as string)) return { ok: false, code: "phone_cut_failed", retry: true };   // still live: nothing was done, the owner may press again in the same window
      phoneKeys.delete(deviceId as string);
      try { deps.pairingChanged(); } catch { /* a notice never changes the answer */ }
    }
    const session = account();
    if (withPairing && session && authorityFor(session.userId, kid) === "no") return { ok: false, code: "phone_cut_key_elsewhere" };   // the pointer proves the server would refuse: no call
    const out = await revokeKey(kid);
    const verdict = cutVerdict(out);
    if (verdict === "done") return { ok: true };
    if (verdict === "wait") {
      if (session && rememberOwed(session.userId, kid)) return { ok: false, code: "phone_cut_key_waits", ...(out.code ? { serverCode: out.code } : {}) };
      return { ok: false, code: out.code ?? "failed" };
    }
    return withPairing ? { ok: false, code: "phone_cut_key_elsewhere", ...(out.code ? { serverCode: out.code } : {}) } : { ok: false, code: out.code ?? "failed" };
  }

  /** "This is not my device" / "Disconnect": a request, run only from the confirmation window. A key line of a phone this computer paired is cut together with that pairing record. */
  function requestRevokeKey(kid: string, only?: { deviceId: string; name: string }): { ok: boolean; code?: string; requestId?: string } {
    const session = account();
    if (!session) return { ok: false, code: "sign_in_required" };
    if (typeof kid !== "string" || !KID_RE.test(kid)) return { ok: false, code: "invalid_args" };
    if (!cache || cache.userId !== session.userId || writesClosed || pointerGone) return { ok: false, code: "one_home_unavailable" };
    if (!writesOpen()) return { ok: false, code: "device_proof_unavailable" };
    // What the confirmation window names (plain text from the server's own device line; absent values are simply not drawn).
    const line = [...(cache?.pointer.pendingDevices ?? []), ...(cache?.pointer.devices ?? [])].find((d) => d.kid === kid) as Record<string, unknown> | undefined;
    const phone = only ?? phoneOfKid(kid);
    const view: Record<string, unknown> = { kid };
    if (typeof line?.label === "string") view.name = Array.from(line.label).slice(0, 64).join("");
    if (!view.name && phone?.name) view.name = Array.from(phone.name).slice(0, 64).join("");
    if (typeof line?.kind === "string") view.deviceKind = line.kind;
    else if (phone) view.deviceKind = "phone";
    if (typeof line?.registeredAt === "number") view.registeredAt = line.registeredAt;
    if (phone && deps.revokePhone) view.alsoPairing = true;   // the window says the direct connection goes too (one sentence); no id
    if (phone && deps.revokePhone && authorityFor(session.userId, kid) === "no") view.keyElsewhere = true;   // the pointer proves this computer cannot cut the key: the window says so before the press
    const deviceId = phone?.deviceId ?? null;
    return confirm.request("revokeKey", view, () => revokeKeyAndPairing(kid, deviceId));
  }

  /**
   * The settings screen's "Disconnect" of one phone (the mobile list knows a device id, not a key). With a key line seen for that phone: the same one confirmation window,
   * and the same cut of both. Without one: `no_device_key` - the screen keeps its own single-record disconnect (there is no key to cut).
   */
  function requestRevokePhone(deviceId: string): { ok: boolean; code?: string; requestId?: string } {
    if (typeof deviceId !== "string" || !/^device_[a-f0-9]{32}$/.test(deviceId)) return { ok: false, code: "invalid_args" };
    const record = deps.pairing()?.phoneTrustRecord(deviceId) ?? null;
    if (!record) return { ok: false, code: "not_found" };
    const kid = phoneKidOf(record);
    if (!kid) return { ok: false, code: "no_device_key" };
    return requestRevokeKey(kid, { deviceId, name: record.name });
  }

  // ── status for the screen (IPC) ──
  function status() {
    const session = account();
    const userId = session?.userId ?? null;
    const record = userId ? loadRecord(userId) : null;
    pruneMemory();
    const pointer = cache && cache.userId === userId ? cache.pointer : null;
    const livingHome = !!record && !!pointer && isLivingHome(record, pointer);
    const owedKids = new Set((record?.revokeOwed ?? []).map((o) => o.kid));   // read with the record the status already reads: no extra read
    const phones = (deps.pairing()?.listPhoneTrust() ?? []).map((phone) => {
      const kid = phoneKidOf(phone);
      const vouch = vouchOf(phone);
      const line = kid && pointer ? pointer.devices.find((d) => d.kid === kid) : undefined;
      // No nonce, no pub, no confirmation number here: the owner window must not be able to compute what the confirmation window shows.
      return {
        deviceId: phone.deviceId, name: phone.name, pairedVia: phone.pairedVia, vouch,
        desktopWork: desktopWorkOf(vouch, line?.viaHome, livingHome),
        pairedAt: Date.parse(phone.issuedAt) > 0 ? Date.parse(phone.issuedAt) : null,
        ...(kid ? { kid, keyRegistered: lineFor(kid) !== null } : {}),
      };
    });
    const mv = isRecord(pointer?.move) ? pointer!.move as Record<string, unknown> : null;
    const mto = mv && isRecord(mv.to) ? mv.to : null;
    return {
      ...mover.view(userId),
      leftover: deps.move?.leftover ? safe(() => leftover.view(userId)) : null,
      /** Audit 62 (§6.1): the nearest moment a waiting move ends or turns by itself (ms), or null. */
      nextDeadlineAt: deps.move ? safe(() => mover.nextDeadline()) : null,
      transfer: transfer ? { ...transfer } : null,
      homeLabel: record?.homeLabel ?? null,
      epoch: record?.epoch ?? null,
      // The pointer's move without its ids, keys and numbers: the owner window must not be able to compute what the confirmation window shows.
      pointerMove: mv ? { phase: mv.phase, from: mv.from, to: mto ? { hostId: mto.hostId, label: mto.label } : null, startedAt: mv.startedAt, expiresAt: mv.expiresAt, expired: mv.expired === true, approved: mv.approved === true, hardExpiresAt: mv.hardExpiresAt ?? null, fenceHeld: mv.fenceHeld ?? null, resumeUntil: mv.resumeUntil ?? null } : null,
      available: !!pointer && !writesClosed,
      state: (record?.state ?? "legacy") as OneHomeLocalState,
      hostId: record?.hostId ?? deps.hostId(),
      kid: record?.kid ?? null,
      pointer: pointer ? {
        home: pointer.home, epoch: pointer.epoch, homeTrust: pointer.homeTrust,
        // The server's device lines carry the nonce a confirmation number is built from; the owner window does not get it.
        claims: pointer.claims, pendingDevices: pointer.pendingDevices.map((d) => revoking(withoutNonce(d), owedKids)), devices: pointer.devices.map((d) => revoking(deviceView(d), owedKids)),
        // Audit 62 (§6.1, pointer §19.7): the ends the server computes - the screen does not learn them as constants.
        ...(pointer.trustInfo ? { trustInfo: pointer.trustInfo } : {}), ...(pointer.owed ? { owed: pointer.owed } : {}),
        ...(isRecord(pointer.last) ? { last: { importDeadline: pointer.last.importDeadline ?? null, reputsLeft: pointer.last.reputsLeft ?? null, bundleHeld: pointer.last.bundleHeld ?? null } } : {}),
      } : null,
      readAt: cache && cache.userId === userId ? cache.readAt : null,
      /** The server's clock minus this computer's (ms; 0 when they agree): the screen counts "N days left" by the server's clock. */
      clockOffsetMs,
      phones,
      screenControl: deps.screenControl(deps.now()),
      pendingReauth: held && held.userId === userId ? { actionId: held.actionId, kind: held.kind } : null,
      blockedClaims: blocked,
      /** the completion card's value (see `ownerAnswer`), or null. */
      ownerAnswer: ownerAnswer ? { ...ownerAnswer, ...(accountUrl() ? { accountUrl: accountUrl() } : {}) } : null,
      /** TG: the one fact about the mirror a person may be told: it has not matched the server for a long time (24 h). `holding` = the closed code of a refusal that waits for the pointer to change. */
      mirror: safe(() => mirror.status()),
      /** Screens ga-1: the review window's tally and the one closed word of a list that could not be read (numbers only: the owner window never gets a word of what waits). */
      waitingReview: { result: review && review.touched ? { at: review.at, accepted: review.accepted, declined: review.declined, newer: review.newer, cut: review.cut } : null, failed: waitingFailed },
      // `away` (design 5.8.8): what an old computer shows. The name of the new home is UNTRUSTED text: a value for the screen only, never a prompt, tool result, notification or log line.
      away: record?.state === "away" ? {
        homeLabel: record.homeLabel ?? null,
        homeTrust: pointer?.homeTrust ?? null,
        homeKind: pointer ? pointer.home.kind : null,
        mode: isRecord(pointer?.last) && typeof pointer!.last.mode === "string" ? pointer!.last.mode : null,
        /** The conversation this computer keeps read-only ("conversation before the move"), or null. */
        beforeMoveChatId: deps.move ? safe(() => mover.beforeChatId(userId)) : null,
        /** A fixed code for the old phone's bubble: the sentence names no computer (design 5.8.0 (5a)); the phone's own text, not a model input. */
        phoneNotice: "home_moved",
      } : null,
    };
  }
  function safe<T>(fn: () => T): T | null { try { return fn(); } catch { return null; } }

  // ── the phone's three methods (bridge) ──
  type Verdict = "ok" | "signed-out" | "mismatch" | "unknown";
  const accountRefusal = (verdict: Verdict): BridgeRefusal | null =>
    verdict === "ok" ? null : { ok: false, code: verdict === "signed-out" ? "sign_in_required" : "account_mismatch" };

  async function bridge(method: "one.home.status" | "one.home.check" | "one.home.deviceKey", params: Record<string, unknown>, ctx: { deviceId: string; devBootstrap: boolean; verdict: Verdict }): Promise<Record<string, unknown>> {
    const refused = accountRefusal(ctx.verdict);
    if (refused) return refused;
    const session = account();
    if (!session) return { ok: false, code: "sign_in_required" };
    const current = cache && cache.userId === session.userId ? cache : null;
    const available = !!current && !writesClosed;

    if (method === "one.home.status") {
      if (!available) return { ok: false, code: "one_home_unavailable" };
      const record = loadRecord(session.userId);
      const phone = deps.pairing()?.phoneTrustRecord(ctx.deviceId) ?? null;
      return {
        ok: true, schemaVersion: 1, hostId: record?.hostId ?? deps.hostId() ?? "", state: record?.state ?? "legacy", epoch: current!.pointer.epoch,
        thisPhone: { vouch: ctx.devBootstrap ? "not_eligible" : vouchOf(phone) },
      };
    }

    if (method === "one.home.check") {
      pruneMemory();
      const reason = params.reason;
      if (reason !== "phone_approved" && reason !== "pointer_changed") return { ok: false, code: "invalid_params" };
      const last = checkSeenAt.get(ctx.deviceId);
      if (last !== undefined && deps.now() - last < MIN_GAP_SIGNAL_MS) return { ok: true, result: "coalesced" };
      checkSeenAt.set(ctx.deviceId, deps.now());
      const neverRead = !lastAttemptAt;
      // The answer is the state as known now; the read itself runs on this signal either way (one GET, never retried).
      void refresh("phone").catch(() => undefined);
      return available || neverRead ? { ok: true, result: "scheduled" } : { ok: false, code: "one_home_unavailable" };
    }

    // one.home.deviceKey — checks in the contract's order (§2): home, connection, record, shape.
    if (!available) return { ok: false, code: "one_home_unavailable" };
    const record = keyed(session.userId);
    const pointer = current!.pointer;
    if (!record || record.state !== "home" || pointer.home.kind !== "desktop" || pointer.home.hostId !== record.hostId || pointer.pub !== record.pub) return { ok: false, code: "not_home" };
    if (pointer.homeTrust === "unconfirmed") return { ok: false, code: "home_unconfirmed" };
    if (ctx.devBootstrap) return { ok: false, code: "not_eligible" };
    const phone = deps.pairing()?.phoneTrustRecord(ctx.deviceId) ?? null;
    if (!phone) return { ok: false, code: "not_eligible" };
    const vouch = vouchOf(phone);
    if (vouch === "not_eligible") return { ok: false, code: "not_eligible" };
    const pub = String(params.pub), possession = String(params.possession), possessionTs = Number(params.possessionTs);
    // MB-1 (contracts/trust-root.md §13): the possession may NAME the computer it was signed for (`possessionHost`, and `hostId` in the signed text). It then counts only for THIS computer, which is the home right now (checked above: `record.hostId` is the pointer's
    // home). The refusal word is the one a proof that does not verify already has - the server answers a host that is not the home with the same `device_proof_invalid`. Without the field the text is what it always was.
    const named = typeof params.possessionHost === "string" ? params.possessionHost : undefined;
    if (named !== undefined && named !== record.hostId) return { ok: false, code: "endorse_refused", serverCode: "device_proof_invalid" };
    // The phone must prove it holds the key (server contract §9): checked here too, so nothing unproven is kept in memory or forwarded.
    const proofOk = Math.abs(deps.now() - possessionTs) <= POSSESSION_WINDOW_MS
      && verifyEd25519(pub, signedText(origin(), "device/possession", session.userId, { pub, kind: "phone", ts: possessionTs, ...(named !== undefined ? { hostId: named } : {}) }), possession);
    if (!proofOk) return { ok: false, code: "endorse_refused", serverCode: "device_proof_invalid" };
    // The phone proved it holds this key: its pairing record remembers which key line is its (once; the same value writes nothing). A failed write never changes the answer.
    try { deps.pairing()?.rememberPhoneKeyKid?.(ctx.deviceId, kidOf(pub)); } catch { /* the link is a convenience of the unified [Disconnect]; the endorse goes on */ }
    if (vouch === "owner_press_needed") {
      stashPhoneKey(ctx.deviceId, pub);
      return lineFor(kidOf(pub)) ? { ok: false, code: "owner_press_needed" } : { ok: false, code: "register_first" };
    }
    const label = typeof params.label === "string" && params.label ? params.label : undefined;
    const out = await post("device/endorse", "kid", { kind: "phone", pub, ...(label ? { label } : {}), possession, possessionTs, ...(named !== undefined ? { possessionHost: named } : {}) }, session, record);
    if (out.ok) return { ok: true, result: out.result === "already" ? "already" : "vouched", kid: kidOf(pub) };
    if (out.code === "one_home_unavailable") return { ok: false, code: "one_home_unavailable" };
    if (out.unreachable) return { ok: false, code: "server_unreachable", retryable: true };
    return { ok: false, code: "endorse_refused", serverCode: out.code };
  }


  /** `move/bundle-put`: the locked bytes are the body; the proof (host, time, nonce, signature over the route, move id, sha-256, byte count) is the base64url JSON header `x-one-home-proof`. */
  async function putBundle(session: { cookie: string; userId: string }, record: KeyedRecord, fields: { moveId: string; sha256: string; bytes: number }, body: Buffer | { file: string }): Promise<CallOut> {
    if (!cache || cache.userId !== session.userId || writesClosed || pointerGone) return { ok: false, code: "one_home_unavailable" };
    if (cache.pointer.writes !== "open") return { ok: false, code: "device_proof_unavailable" };
    const unsigned = { hostId: record.hostId, ts: deps.now(), nonce: randomBytes(16).toString("base64url"), ...fields };
    const sig = signWith(record.privateKey, signedText(origin(), "move/bundle-put", session.userId, unsigned));
    // Audit 62 / a file is sent as a stream (node:http with back-pressure, bundle-stream.ts): the 100 MiB is neither held for the request nor queued by `fetch`; progress is on the state; the time allowed grows with the size.
    const headers = { cookie: session.cookie, "x-agentlas-client": "desktop", accept: "application/json", "content-type": "application/octet-stream", "x-one-home-proof": Buffer.from(JSON.stringify({ ...unsigned, sig }), "utf8").toString("base64url") };
    transfer = { phase: "upload", done: 0, total: fields.bytes, since: deps.now() };
    const startedMs = Date.now();
    try {
      let status: number; let parsed: unknown;
      if (!Buffer.isBuffer(body)) {
        const res = await httpPostFile(endpoint("/move/bundle-put"), { headers, file: body.file, timeoutMs: requestTimeoutMs(fields.bytes), onProgress: (sent, total) => { transfer = { phase: "upload", done: sent, total, since: transfer?.since ?? deps.now() }; } });
        status = res.status; parsed = res.json();
      } else {
        const res = await deps.fetch(endpoint("/move/bundle-put"), { method: "POST", body, signal: AbortSignal.timeout(requestTimeoutMs(fields.bytes)), headers: { ...headers, "content-length": String(body.length) } });
        status = res.status; parsed = await res.json().catch(() => null);
      }
      const answer = isRecord(parsed) ? parsed : null;
      if (status >= 200 && status < 300 && answer?.ok === true) { adoptPointer(session.userId, answer.pointer); return { ok: true, result: typeof answer.result === "string" ? answer.result : "done", body: answer }; }
      if (answer?.pointer) adoptPointer(session.userId, answer.pointer);
      return { ok: false, code: typeof answer?.error === "string" ? answer.error : "failed", status, body: answer };
    } catch (e) {
      // Repair 5 (web 408): a send that stopped after a long slow stretch with bytes still unsent - this computer's own time (60 s + 3 s per MiB, no bytes for that long), or a connection a server with the OLD request time (300 s) cut - is the same fact as the server's
      // `request_timeout`: the line is too slow for this size. Anything quicker is plain `server_unreachable` (offline, refused).
      const sent = transfer?.done ?? 0;
      if ((e as Error)?.message === "timeout" || (sent < fields.bytes && Date.now() - startedMs >= 60_000)) return { ok: false, code: "request_timeout", status: 0, body: { reason: "client_too_slow", retryable: true } };
      return { ok: false, code: "server_unreachable", unreachable: true };
    }
    finally { transfer = null; }
  }
  /** `move/bundle-get`: the size is checked against the declared length BEFORE the body is read. */
  async function getBundle(session: { cookie: string; userId: string }, record: KeyedRecord, moveId: string, maxBytes: number, dest?: string): Promise<{ ok: true; bytes: Buffer } | { ok: true; file: string; size: number; sha256: string } | { ok: false; code: string; unreachable?: boolean }> {
    if (!cache || cache.userId !== session.userId || writesClosed || pointerGone) return { ok: false, code: "one_home_unavailable" };
    if (cache.pointer.writes !== "open") return { ok: false, code: "device_proof_unavailable" };
    const head = { hostId: record.hostId, ts: deps.now(), nonce: randomBytes(16).toString("base64url"), moveId };
    const sig = signWith(record.privateKey, signedText(origin(), "move/bundle-get", session.userId, head));
    if (dest) {
      // Audit 62 / written to the file as it arrives (back-pressure, sha-256 counted); the caller checks size and hash BEFORE the bytes are read into memory.
      transfer = { phase: "download", done: 0, total: null, since: deps.now() };
      try {
        const res = await httpPostJsonToFile(endpoint("/move/bundle-get"), { headers: { cookie: session.cookie, "x-agentlas-client": "desktop", "content-type": "application/json", accept: "application/octet-stream, application/json" }, json: JSON.stringify({ ...head, sig }), dest, maxBytes, timeoutMs: requestTimeoutMs(maxBytes), onProgress: (n, total) => { transfer = { phase: "download", done: n, total, since: transfer?.since ?? deps.now() }; } });
        if (res.streamed) return res.streamed.ok ? { ok: true, file: dest, size: res.streamed.bytes, sha256: res.streamed.sha256 } : { ok: false, code: res.streamed.code };
        const parsed = res.json();
        if (isRecord(parsed) && isRecord(parsed.pointer)) adoptPointer(session.userId, parsed.pointer);
        if (isRecord(parsed) && parsed.error === "rate_limited" && parsed.limit === "count") return { ok: false, code: "bundle_missing" };   // (pointer §19.3): the fetches are used up = the held bytes are gone: the old home puts them again
        return { ok: false, code: isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : "failed" };
      } catch { return { ok: false, code: "server_unreachable", unreachable: true }; }
      finally { transfer = null; }
    }
    try {
      const res = await deps.fetch(endpoint("/move/bundle-get"), { method: "POST", signal: AbortSignal.timeout(requestTimeoutMs(maxBytes)), headers: { cookie: session.cookie, "x-agentlas-client": "desktop", "content-type": "application/json", accept: "application/octet-stream, application/json" }, body: JSON.stringify({ ...head, sig }) });
      const type = res.headers?.get("content-type") ?? "";
      if (res.status === 200 && type.startsWith("application/octet-stream") && res.arrayBuffer) {
        const declared = Number(res.headers?.get("content-length") ?? NaN);
        if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, code: "bundle_too_large" };
        const bytes = Buffer.from(await res.arrayBuffer());
        return bytes.length > maxBytes ? { ok: false, code: "bundle_too_large" } : { ok: true, bytes };
      }
      const parsed = await res.json().catch(() => null);
      if (isRecord(parsed) && isRecord(parsed.pointer)) adoptPointer(session.userId, parsed.pointer);
      // Audit 62 (pointer §19.3): a COUNT limit on the fetches (`fetch_used_up`, `retryable: false`) is the end of the bytes, not a pause: the held bundle is gone and the old home puts them again - the same as a missing bundle (`waiting_redeposit`), never a call repeated at every signal.
      if (isRecord(parsed) && parsed.error === "rate_limited" && parsed.limit === "count") return { ok: false, code: "bundle_missing" };
      return { ok: false, code: isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : "failed" };
    } catch { return { ok: false, code: "server_unreachable", unreachable: true }; }
  }

  // ── the move (home-move.ts) ──
  // ── the mirror (home-mirror.ts): the home's upload and take, signed by this computer's key for the pointer's epoch ──
  let lastReadSignal: OneHomeSignal = "turn";
  /** TR-desktop 4: the read in flight began with no pointer at all (a restore that failed offline): only that read stands in for the mirror's missed "start". A refresh of a pointer already held (the work sweep's) asks the mirror for nothing. */
  let readFromNothing = false;
  let readForMirror = false;
  /** A pointer read made by the mirror itself (after `stale_epoch`) does not ask the mirror to run again. */
  function kickMirror(): void {
    if (readForMirror || (lastReadSignal === "sweep" && !readFromNothing)) return;
    if (lastReadSignal === "request" && !readFromNothing) return;   // the response wait's read asks the mirror for nothing either
    try { void mirror.signal(lastReadSignal === "restore" || lastReadSignal === "login" || lastReadSignal === "wake" || lastReadSignal === "sweep" ? "start" : "turn").catch(() => undefined); } catch { /* a signal never changes its sender */ }
  }
  const mirrorPorts: HomeMirrorPorts = {
    now: () => deps.now(),
    userId: () => deps.session()?.userId ?? null,
    switchOn: () => { try { return deps.mirrorSwitchOn?.() === true; } catch { return false; } },
    standing: () => {
      const session = deps.session();
      if (!session) return { ok: false, why: "signed_out", key: "" };
      if (!cache || cache.userId !== session.userId || pointerGone) return { ok: false, why: "no_pointer", key: "none" };
      if (writesClosed || cache.pointer.writes !== "open") return { ok: false, why: "device_proof_unavailable", key: `closed:${cache.pointer.epoch}` };
      const record = keyed(session.userId);
      if (!record) return { ok: false, why: "no_device_key", key: "nokey" };
      const pointer = cache.pointer;
      const key = `${pointer.epoch}:${pointer.homeTrust}:${record.state}`;
      if (!isLivingHome(record, pointer)) return { ok: false, why: "not_home", key };
      if (record.move) return { ok: false, why: "move_in_progress", key };
      if (pointer.homeTrust === "unconfirmed") return { ok: false, why: "home_unconfirmed", key };
      return { ok: true, epoch: pointer.epoch, key };
    },
    /** TH: the same checks as `standing`, for a computer that has COMMITTED a server-start move and is catching up (its record still carries the move): the move is not a reason to refuse. */
    standingDuringMove: () => {
      const session = deps.session();
      if (!session) return { ok: false, why: "signed_out", key: "" };
      if (!cache || cache.userId !== session.userId || pointerGone) return { ok: false, why: "no_pointer", key: "none" };
      if (writesClosed || cache.pointer.writes !== "open") return { ok: false, why: "device_proof_unavailable", key: `closed:${cache.pointer.epoch}` };
      const record = keyed(session.userId);
      if (!record) return { ok: false, why: "no_device_key", key: "nokey" };
      const pointer = cache.pointer;
      const key = `${pointer.epoch}:${pointer.homeTrust}:${record.state}:move`;
      if (!isLivingHome(record, pointer)) return { ok: false, why: "not_home", key };
      if (pointer.homeTrust === "unconfirmed") return { ok: false, why: "home_unconfirmed", key };
      return { ok: true, epoch: pointer.epoch, key };
    },
    call: async (route, fields) => {
      const session = deps.session(); if (!session) return { ok: false, code: "sign_in_required" };
      const record = keyed(session.userId); if (!record) return { ok: false, code: "no_device_key" };
      const out = await post(route, "host", fields, session, record);
      if (out.ok) return { ok: true, body: out.body };
      const bad = out as { code?: string; status?: number; unreachable?: boolean; retryable?: boolean; body?: unknown };
      return { ok: false, ...(bad.status !== undefined ? { status: bad.status } : {}), ...(bad.code ? { code: bad.code } : {}), ...(bad.unreachable ? { unreachable: true } : {}), ...(bad.retryable ? { retryable: true } : {}), body: (bad.body as Record<string, unknown> | null | undefined) ?? null };
    },
    refreshPointer: async () => { const s = account(); if (!s) return; readForMirror = true; try { await readOnce(s); } finally { readForMirror = false; } },
    loadState: (userId) => deps.getMeta(MIRROR_KEY(userId)),
    saveState: (userId, json) => deps.setMeta(MIRROR_KEY(userId), json),
    clearState: (userId) => deps.setMeta(MIRROR_KEY(userId), ""),
    store: () => deps.mirrorStore?.() ?? null,
  };
  /** VD: `POST mirror/file {epoch, id}` for a file the server holds: signed like every other mirror call, never throws. After `stale_epoch` the pointer is read once and the call made once more (the file's job is retried at the next signal anyway). */
  async function signedFileLink(id: string): Promise<SignedAnswer> {
    const session = deps.session(); if (!session) return { ok: false, code: "sign_in_required" };
    const record = keyed(session.userId); if (!record) return { ok: false, code: "no_device_key" };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const standing = mirrorPorts.standing();
      if (!standing.ok) return { ok: false, code: standing.why };
      const out = await post("mirror/file", "host", { epoch: standing.epoch, id }, session, record);
      if (out.ok) return { ok: true, body: out.body };
      const bad = out as { code?: string; status?: number; unreachable?: boolean; body?: unknown };
      if (bad.code === "stale_epoch" && attempt === 0) { await mirrorPorts.refreshPointer(); continue; }
      return { ok: false, ...(bad.status !== undefined ? { status: bad.status } : {}), ...(bad.code ? { code: bad.code } : {}), ...(bad.unreachable ? { unreachable: true } : {}), body: (bad.body as Record<string, unknown> | undefined) ?? null };
    }
    return { ok: false, code: "stale_epoch" };
  }
  {
    const filePorts = deps.mirrorFilesPorts?.({ signedLink: signedFileLink, mayTake: () => mirrorPorts.switchOn() && mirrorPorts.standing().ok });
    mirrorPorts.files = filePorts ? createMirrorFiles(filePorts) : null;
  }
  /*
   * DD: the connected apps of the server (server-apps.ts). Its three requests are signed here, like every mirror call, by the key of this computer for the pointer's epoch;
   * the mirror's signals (start, home, turn) and the `appsRev` of its upload answer are the only things that ask it to look again (home-mirror.ts `apps`). Main only: without
   * `serverAppsExtras` (the background service has no device key) there is no instance and a turn sees no server app.
   */
  const serverApps: ServerApps | null = (() => {
    const extras = deps.serverAppsExtras?.({ files: () => mirrorPorts.files ?? null });
    if (!extras) return null;
    return createServerApps({
      now: () => deps.now(),
      userId: () => deps.session()?.userId ?? null,
      switchOn: () => mirrorPorts.switchOn(),
      standing: () => { const standing = mirrorPorts.standing(); return standing.ok ? { ok: true as const, epoch: standing.epoch } : { ok: false as const, why: standing.why }; },
      call: async (route, fields, waitMs) => {
        const session = deps.session(); if (!session) return { ok: false, code: "sign_in_required" };
        const record = keyed(session.userId); if (!record) return { ok: false, code: "no_device_key" };
        const out = await post(route, "host", fields, session, record, waitMs);
        if (out.ok) return { ok: true, status: 200, body: out.body };
        const bad = out as { code?: string; status?: number; unreachable?: boolean; retryable?: boolean; body?: unknown };
        return { ok: false, ...(bad.status !== undefined ? { status: bad.status } : {}), ...(bad.code ? { code: bad.code } : {}), ...(bad.unreachable ? { unreachable: true } : {}), ...(bad.retryable ? { retryable: true } : {}), body: (bad.body as Record<string, unknown> | null | undefined) ?? null };
      },
      refreshPointer: () => mirrorPorts.refreshPointer(),
      loadState: (userId) => deps.getMeta(`${SERVER_APPS_META_PREFIX}${userId}`),
      saveState: (userId, json) => deps.setMeta(`${SERVER_APPS_META_PREFIX}${userId}`, json),
      clearState: (userId) => deps.setMeta(`${SERVER_APPS_META_PREFIX}${userId}`, ""),
      ...extras,
    });
  })();
  mirrorPorts.apps = serverApps ? { signal: (kind) => { if (kind === "start" || kind === "home" || kind === "turn") serverApps.signal(kind); }, seen: (rev) => serverApps.seenRev(rev) } : null;
  const mirror: HomeMirror = createHomeMirror(mirrorPorts);

  const mover: HomeMove = createHomeMove({
    now: () => deps.now(),
    account: () => account(),
    pointer: () => { const s = deps.session(); return cache && s && cache.userId === s.userId ? cache.pointer : null; },
    keyed: (userId) => keyed(userId),
    ensureKey: (userId) => ensureKey(userId),
    load: (userId) => loadRecord(userId),
    save: (userId, record) => writeRecord(userId, record),
    call: (route, mode, fields, session, record) => post(route, mode, fields, session, record as KeyedRecord),
    readPointer: async () => { const s = account(); return s ? readOnce(s) : false; },
    writesClosed: () => writesClosed,
    writesOpen: () => writesOpen(),
    serverShut: () => { const s = deps.session(); return writesClosed || pointerGone || (!!cache && !!s && cache.userId === s.userId && cache.pointer.writes !== "open"); },
    screenActive: () => deps.screenControl(deps.now()).active === true,
    forgetHomeBox: (userId) => dropHomeBox(userId),
    holdForReauth: (userId, retry) => { held = { actionId: randomBytes(9).toString("base64url"), kind: "move", userId, createdAt: deps.now(), retried: false, retry }; return held.actionId; },
    confirm,
    confirmCode: (value, pub) => confirmCode(value, pub),
    signedText: (route, userId, body) => signedText(origin(), route, userId, body),
    verify: (pub, text, sig) => verifyEd25519(pub, text, sig),
    putBundle: (session, record, fields, body) => putBundle(session, record as KeyedRecord, fields, body),
    getBundle: (session, record, moveId, maxBytes, dest) => getBundle(session, record as KeyedRecord, moveId, maxBytes, dest),
    computerLabel: () => deps.computerLabel(),
    answered: (kind) => noteOwnerAnswer(kind),
    keyStoreAvailable: () => deps.keyStore.available(),
    // TH: the mirror's one more take (`caughtUp`) and its first upload after the move ends are the mirror's own, passed in here (the mirror is built above)
    // (a prototype link, not a copy: a gate that sets `crash` on its own deps object after the home was made still reaches it)
    deps: deps.move ? Object.create(deps.move, { catchUp: { value: () => mirror.catchUp() }, afterDone: { value: () => { void mirror.signal("home").catch(() => undefined); } } }) as MoveDeps : UNAVAILABLE_MOVE,
    passEnded: () => { aimDeadline(); aimResponseWait(); },
  });

  // ── (home D2): ONE one-shot timer, only while a move waits ──
  // Not a poll: it exists only while a move record exists and has a future end (the pointer's `move.expiresAt`, the 30-day purge wait, the 7 days after a commit, a claim's wait), is aimed at that moment, fires once, and
  // is cleared when the move ends, the account changes or the app stops (`unref`: it never keeps the process alive). Its one act is the same as any signal: one pointer read, one pass. A moment already past is never aimed at again.
  const MAX_TIMER_MS = 20 * 24 * 3_600_000;   // below Node's 2^31 ms limit (about 24.8 days); a later deadline is aimed at again when this one fires
  const DEADLINE_SLACK_MS = 2_000;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null; let deadlineAt: number | null = null;
  function clearDeadline(): void { if (deadlineTimer) clearTimeout(deadlineTimer); deadlineTimer = null; deadlineAt = null; }
  function aimDeadline(): void {
    try {
      if (!deps.move) { clearDeadline(); return; }
      const at = mover.nextDeadline();
      if (at === null) { clearDeadline(); return; }
      if (deadlineTimer && deadlineAt === at) return;
      clearDeadline();
      deadlineAt = at;
      const wait = Math.min(Math.max(0, at - deps.now()) + DEADLINE_SLACK_MS, MAX_TIMER_MS);
      deadlineTimer = setTimeout(() => {
        deadlineTimer = null; deadlineAt = null;
        void refresh("turn").catch(() => undefined).then(() => mover.drive()).catch(() => undefined);
      }, wait);
      (deadlineTimer as { unref?: () => void }).unref?.();
    } catch { clearDeadline(); }
  }
  /** A cause on this computer that held the move has ended (home-signal.ts): one read of the pointer and one pass, only when the move waits for such a cause. */
  function causeEnded(): void {
    try {
      if (!deps.move || !mover.waitingOnLocalCause()) return;
      void refresh("turn").catch(() => undefined).then(() => mover.drive()).catch(() => undefined);
    } catch { /* a signal never changes its sender */ }
  }

  // ── (contract home-move-phone-card §7 R8): the response wait, the one read without a signal ──
  // Only while this computer waits for a person on another device to answer its request (`mover.awaitingResponse()`: receiver from a computer, the request is ours and not expired, the step waits for the other device) and only in the
  // Main process (`deps.move` exists only there: the background service has none). A chain of ONE one-shot timer (3 s for the first 2 minutes, then 15 s, `unref`), never a repeating timer; each firing is one pointer read and one pass.
  // It is aimed from the end of every pass (`passEnded`), so a restore / wake / sign-in read that finds the wait starts it again after a restart; it is cleared the moment the condition is false, at a sign-out, an account change and `reset()`.
  let responseTimer: ReturnType<typeof setTimeout> | null = null; let responseTicking = false;
  function clearResponseWait(): void { if (responseTimer) clearTimeout(responseTimer); responseTimer = null; }
  function aimResponseWait(): void {
    try {
      if (!deps.move) { clearResponseWait(); return; }
      const wait = mover.awaitingResponse();
      const ms = responseWaitDelay(wait, deps.now());
      if (ms === null) { clearResponseWait(); return; }
      if (responseTimer || responseTicking) return;
      responseTimer = setTimeout(() => { responseTimer = null; void responseTick(); }, ms);
      (responseTimer as { unref?: () => void }).unref?.();
    } catch { clearResponseWait(); }
  }
  async function responseTick(): Promise<void> {
    responseTicking = true;
    try {
      if (!mover.awaitingResponse()) return;                     // the condition went false while the timer slept: no read
      await refresh("request").catch(() => undefined);           // a failed read (offline) keeps the request and the same interval
      await mover.drive().catch(() => undefined);
    } catch { /* a timer never throws */ } finally { responseTicking = false; aimResponseWait(); }
  }
  function responseWaitState(): { armed: boolean; ticking: boolean } { return { armed: responseTimer !== null, ticking: responseTicking }; }

  // ── the leftover (home-leftover.ts): the old records of a computer that is not the home ──
  /** `leftover`: the locked bytes are the body; the proof (kid, time, nonce, signature over the route, host, the two keys it is locked to, sha-256, byte count) is the base64url JSON header `x-one-home-proof`. */
  async function putLeftover(session: { cookie: string; userId: string }, record: KeyedRecord, fields: { sealedToPub: string; sealedToBox: string; sha256: string; bytes: number }, body: Buffer): Promise<CallOut> {
    if (!cache || cache.userId !== session.userId || writesClosed || pointerGone) return { ok: false, code: "one_home_unavailable" };
    if (cache.pointer.writes !== "open") return { ok: false, code: "device_proof_unavailable" };
    const unsigned = { kid: record.kid, ts: deps.now(), nonce: randomBytes(16).toString("base64url"), hostId: record.hostId, ...fields };
    const sig = signWith(record.privateKey, signedText(origin(), "leftover", session.userId, unsigned));
    try {
      const res = await deps.fetch(endpoint("/leftover"), {
        method: "POST", body, signal: AbortSignal.timeout(requestTimeoutMs(fields.bytes)),
        headers: { cookie: session.cookie, "x-agentlas-client": "desktop", accept: "application/json", "content-type": "application/octet-stream", "content-length": String(body.length), "x-one-home-proof": Buffer.from(JSON.stringify({ ...unsigned, sig }), "utf8").toString("base64url") },
      });
      const parsed = await res.json().catch(() => null);
      const answer = isRecord(parsed) ? parsed : null;
      if (res.status >= 200 && res.status < 300 && answer?.ok === true) { adoptPointer(session.userId, answer.pointer); return { ok: true, result: typeof answer.result === "string" ? answer.result : "done", body: answer }; }
      if (res.status === 503 && answer?.error === "device_proof_unavailable") writesClosed = true;
      else if (answer?.pointer) adoptPointer(session.userId, answer.pointer);
      return { ok: false, code: typeof answer?.error === "string" ? answer.error : "failed", status: res.status, body: answer };
    } catch { return { ok: false, code: "server_unreachable", unreachable: true }; }
  }
  /** `leftover/get`: the size is checked against the declared length BEFORE the body is read. */
  async function getLeftover(session: { cookie: string; userId: string }, record: KeyedRecord, kid: string, sha256: string, maxBytes: number): Promise<{ ok: true; bytes: Buffer } | { ok: false; code: string; unreachable?: boolean }> {
    if (!cache || cache.userId !== session.userId || writesClosed || pointerGone) return { ok: false, code: "one_home_unavailable" };
    if (cache.pointer.writes !== "open") return { ok: false, code: "device_proof_unavailable" };
    const head = { hostId: record.hostId, ts: deps.now(), nonce: randomBytes(16).toString("base64url"), kid, sha256 };
    const sig = signWith(record.privateKey, signedText(origin(), "leftover/get", session.userId, head));
    try {
      const res = await deps.fetch(endpoint("/leftover/get"), { method: "POST", signal: AbortSignal.timeout(requestTimeoutMs(maxBytes)), headers: { cookie: session.cookie, "x-agentlas-client": "desktop", "content-type": "application/json", accept: "application/octet-stream, application/json" }, body: JSON.stringify({ ...head, sig }) });
      const type = res.headers?.get("content-type") ?? "";
      if (res.status === 200 && type.startsWith("application/octet-stream") && res.arrayBuffer) {
        const declared = Number(res.headers?.get("content-length") ?? NaN);
        if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, code: "bundle_too_large" };
        const bytes = Buffer.from(await res.arrayBuffer());
        return bytes.length > maxBytes ? { ok: false, code: "bundle_too_large" } : { ok: true, bytes };
      }
      const parsed = await res.json().catch(() => null);
      if (isRecord(parsed) && isRecord(parsed.pointer)) adoptPointer(session.userId, parsed.pointer);
      return { ok: false, code: isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : "failed" };
    } catch { return { ok: false, code: "server_unreachable", unreachable: true }; }
  }
  const leftover: HomeLeftover = createHomeLeftover({
    now: () => deps.now(),
    account: () => account(),
    pointer: () => { const s = deps.session(); return cache && s && cache.userId === s.userId ? cache.pointer : null; },
    keyed: (userId) => keyed(userId),
    load: (userId) => loadRecord(userId),
    save: (userId, record) => writeRecord(userId, record),
    call: (route, mode, fields, session, record) => post(route, mode, fields, session, record as KeyedRecord),
    putLeftover: (session, record, fields, body) => putLeftover(session, record as KeyedRecord, fields, body),
    getLeftover: (session, record, kid, sha, max) => getLeftover(session, record as KeyedRecord, kid, sha, max),
    readPointer: async () => { const s = account(); return s ? readOnce(s) : false; },
    writesOpen: () => writesOpen(),
    confirm,
    signedText: (route, userId, body) => signedText(origin(), route, userId, body),
    verify: (pub, text, sig) => verifyEd25519(pub, text, sig),
    kidOf: (pub) => kidOf(pub),
    deps: deps.move ?? UNAVAILABLE_MOVE,
  });

  const MOVE_UNAVAILABLE = { ok: false as const, code: "move_unavailable" };
  /** An id that came with an owner press must be the one in the pointer now (the number was computed from it). `undefined` = the owner window does not know ids: the request takes the current one. */
  function pointerClaim(claimId: unknown): Record<string, unknown> | null {
    if (typeof claimId !== "string" || !CLAIM_ID_RE.test(claimId)) return null;
    return cache?.pointer.claims.find((c) => c.claimId === claimId) ?? null;
  }
  /** [yes, it is me] / [no, it is not me] on a claim: requests only; the run is the confirmation window's press (gate: home-confirm.ts, which also refuses while the screen is operated). */
  function requestClaimDecision(kind: "approveClaim" | "rejectClaim", claimId: unknown): { ok: boolean; code?: string; requestId?: string } {
    const session = account(); if (!session) return { ok: false, code: "sign_in_required" };
    if (!cache || cache.userId !== session.userId || writesClosed || pointerGone) return { ok: false, code: "one_home_unavailable" };
    if (!writesOpen()) return { ok: false, code: "device_proof_unavailable" };
    const claim = pointerClaim(claimId);
    if (!claim) return { ok: false, code: "claim_not_found" };
    const to = isRecord(claim.to) ? claim.to : null;
    const code = to && typeof to.pub === "string" ? confirmCode(String(claim.claimId), to.pub) : null;
    const decide = (route: "claim/approve" | "claim/reject") => async (): Promise<{ ok: boolean; code?: string }> => {
      const out = await decideNow(route);
      if (out.ok && route === "claim/reject") noteOwnerAnswer("declined");   // the refusal that went through (the card's [This wasn't me] and the window's "this wasn't me")
      return out;
    };
    const decideNow = async (route: "claim/approve" | "claim/reject"): Promise<{ ok: boolean; code?: string }> => {
      const s = account();
      if (!s) return { ok: false, code: "sign_in_required" };
      if (!pointerClaim(claimId)) return { ok: false, code: "claim_not_found" };   // the request changed after the number was shown: nothing is approved
      const key = keyed(s.userId);
      if (!key) return { ok: false, code: deps.keyStore.available() ? "no_device_key" : "key_storage_unavailable" };
      const out = await post(route, "kid", { claimId }, s, key);
      return out.ok ? { ok: true } : { ok: false, code: out.code };
    };
    // The window that asks "yes, it was me" also carries "this wasn't me": the same refusal as [it was not me] on the card (claim/reject), answered from that window.
    return confirm.request(kind, { claimId, ...(code ? { confirmCode: code } : {}), label: typeof to?.label === "string" ? to.label : undefined, claimKind: claim.kind, ...(claim.createdAt !== undefined ? { at: claim.createdAt } : {}) },
      decide(kind === "approveClaim" ? "claim/approve" : "claim/reject"), kind === "approveClaim" ? decide("claim/reject") : undefined);
  }
  /**
   * MT (contracts/mirror-trust.md section 4): what a place that is not trusted made on the server waits for the owner. The list is read from the server when the owner's window asks (nothing is stored here); EVERY text in it is the other
   * side's words and goes to that window as plain text (`textOnly: true`). Refused while something operates the screen. Owner window only (the channel); never an app-control operation, a phone method or an automation.
   */
  async function waitingList(): Promise<WaitingList | { ok: false; code: string }> {
    if (deps.screenControl(deps.now()).active) return { ok: false, code: "screen_control_active" };
    const session = account(); if (!session) return { ok: false, code: "sign_in_required" };
    if (!cache || cache.userId !== session.userId || writesClosed || pointerGone) return { ok: false, code: "one_home_unavailable" };
    return mirror.waitingList();
  }
  /** Audit D10: the whole text of ONE item the list showed cut (plain text, owner window only; the same refusals as the list). */
  async function waitingItem(input: unknown): Promise<{ ok: true; textOnly: true; item: unknown } | { ok: false; code: string }> {
    if (!isRecord(input) || Object.keys(input).length !== 2 || (input.list !== "turns" && input.list !== "gone") || typeof input.id !== "string") return { ok: false, code: "invalid_args" };
    if (deps.screenControl(deps.now()).active) return { ok: false, code: "screen_control_active" };
    const session = account(); if (!session) return { ok: false, code: "sign_in_required" };
    if (!cache || cache.userId !== session.userId || writesClosed || pointerGone) return { ok: false, code: "one_home_unavailable" };
    return mirror.waitingItem(input.list, input.id);
  }
  /**
   * Screens ga-1: the ONE review window for what waits (it replaces the two kinds `acceptWaiting` / `rejectWaiting`, so the owner does not choose accept or decline before seeing what it is). The owner window only REQUESTS it
   * (`oneHome:reviewWaiting`); the window then reads the list itself (`reviewList`), reads one long text whole (`reviewItem`) and answers over a selection (`reviewDecide`), all on channels only that window's own webContents may call
   * (home-confirm.ts `session()`: the first second, the screen-control check, the live request). The words never reach the owner window: it is told numbers and one closed word (`status().waitingReview`, `mirror.waiting`).
   */
  async function requestWaitingReview(): Promise<{ ok: boolean; code?: string; requestId?: string }> {
    const session = account(); if (!session) return { ok: false, code: "sign_in_required" };
    if (!cache || cache.userId !== session.userId || writesClosed || pointerGone) return { ok: false, code: "one_home_unavailable" };
    if (!writesOpen()) return { ok: false, code: "device_proof_unavailable" };
    const epoch = cache.pointer.epoch;
    let count = 0; try { count = Math.max(0, Math.min(9999, Math.floor(mirror.status().waiting))); } catch { count = 0; }   // a number only: the window titles itself with it while it reads the list
    const out = confirm.request("reviewWaiting", { waiting: count }, () => ({ ok: false, code: "session_kind" }));
    if (out.ok) review = { epoch, userId: session.userId, accepted: 0, declined: 0, newer: 0, cut: 0, touched: false, at: deps.now() };
    return out;
  }
  const noteRead = (code: string | undefined): void => { waitingFailed = code === "server_unreachable" ? "server_unreachable" : null; };
  const requestIdOf = (input: unknown): unknown => (isRecord(input) ? input.requestId : undefined);
  /** The review window reads the list (text-only items for that window). */
  async function reviewList(event: unknown, input: unknown): Promise<(WaitingList & { screenBusy: boolean }) | { ok: false; code: string }> {
    const g = confirm.session(event, requestIdOf(input), "reviewWaiting", { press: false }); if (!g.ok) return g;
    const out = await waitingList();
    if (!out.ok) { noteRead(out.code); return { ok: false, code: out.code }; }
    noteRead(undefined);
    if (review) review.cut = out.items.filter((i) => (i.t === "words" || i.t === "forget") && i.cut === true).length;
    return { ...out, screenBusy: g.screenBusy };
  }
  /** The review window reads one long text whole (only an item the list said it cut). */
  async function reviewItem(event: unknown, input: unknown): Promise<{ ok: true; textOnly: true; item: unknown } | { ok: false; code: string }> {
    const g = confirm.session(event, requestIdOf(input), "reviewWaiting", { press: false }); if (!g.ok) return g;
    if (!isRecord(input) || Object.keys(input).length !== 3 || (input.list !== "turns" && input.list !== "gone") || typeof input.id !== "string") return { ok: false, code: "invalid_args" };
    return waitingItem({ list: input.list, id: input.id });
  }
  /** The review window's answer over a selection: [Decline] or [Accept N]. One signed request (mirror.confirmWaiting); Main's own rule leaves out a cut text that was not read whole (`apart`). Nothing runs unless the live request is this window's. */
  async function reviewDecide(event: unknown, input: unknown): Promise<{ ok: true; done: { facts: number; gone: number; turns: number; profile: number; apart?: number; newer?: number }; reupload: number } | { ok: false; code: string }> {
    const g = confirm.session(event, requestIdOf(input), "reviewWaiting", { press: true }); if (!g.ok) return g;
    if (!isRecord(input) || Object.keys(input).length !== 3 || (input.decision !== "accept" && input.decision !== "reject")) return { ok: false, code: "invalid_args" };
    const selection = cleanSelection(input.selection); if (!selection) return { ok: false, code: "invalid_args" };
    const decision: WaitingDecision = input.decision;
    const s = account();
    if (!s || !review || review.userId !== s.userId) return { ok: false, code: "sign_in_required" };
    if (!cache || cache.userId !== s.userId || cache.pointer.epoch !== review.epoch) return { ok: false, code: "request_changed" };   // the home moved after the window opened: nothing is answered
    const out = await mirror.confirmWaiting(decision, selection);
    if (!out.ok) { noteRead(out.code); return { ok: false, code: out.code }; }
    noteRead(undefined);
    const n = out.done.facts + out.done.gone + out.done.turns + out.done.profile;
    review.touched = true; review.at = deps.now();
    if (decision === "accept") review.accepted += n; else { review.declined += n; review.newer += out.done.newer ?? 0; }
    return { ok: true, done: out.done, reupload: out.reupload };
  }
  /** The line's [Try again]: read the list now and keep only whether it could be read (the items are dropped here; the owner window is never given them). */
  async function waitingCheck(): Promise<{ ok: boolean; code?: string }> {
    const out = await waitingList();
    if (!out.ok) { noteRead(out.code); return { ok: false, code: out.code }; }
    noteRead(undefined);
    return { ok: true };
  }
  /**
   * the end of "the connection is not confirmed" is the signal for what that state held back. Only a confirmation: (1) a move that waited for exactly that cause is driven now (home-move.ts `confirmedHome`; its upload follows
   * the move's own end), (2) the mirror is asked once - the first upload of a computer that was never in a move (`kickMirror` did not run when the last pointer read was a sweep). A revert changes nothing here. Never throws, never waited for.
   */
  function afterDecision(kind: "confirmHome" | "revertHome", userId: string): void {
    if (kind === "revertHome") noteOwnerAnswer("restored");   // only the success paths of the decision call this
    if (kind !== "confirmHome") return;
    try { if (deps.move) void mover.confirmedHome(userId).catch(() => undefined); } catch { /* the move is driven by its next signal anyway */ }
    try { void mirror.signal("home").catch(() => undefined); } catch { /* a signal never changes its sender */ }
  }
  /** the server's closed `reason` of a refusal (`device_not_trusted` says why: `older_trusted_key_required`, `strong_signin_required`...) as `detail`, so the window picks its sentence by a word and never reads a server sentence. */
  function closedReason(out: WriteOutcome): { detail?: string } {
    const reason = isRecord(out.body) ? out.body.reason : undefined;
    return typeof reason === "string" && /^[a-z_]{1,48}$/.test(reason) ? { detail: reason } : {};
  }
  /** The two answers about a home that "waited its way in" (unconfirmed): [it was me] and [it was not me]. Run from the confirmation window only. */
  function requestHomeDecision(kind: "confirmHome" | "revertHome"): { ok: boolean; code?: string; requestId?: string } {
    const session = account(); if (!session) return { ok: false, code: "sign_in_required" };
    if (!cache || cache.userId !== session.userId || writesClosed || pointerGone) return { ok: false, code: "one_home_unavailable" };
    if (!writesOpen()) return { ok: false, code: "device_proof_unavailable" };
    if (cache.pointer.homeTrust !== "unconfirmed") return { ok: false, code: "not_unconfirmed" };
    const sinceEpoch = cache.pointer.epoch;
    const homeLabel = cache.pointer.home.kind === "desktop" && typeof cache.pointer.home.label === "string" ? cache.pointer.home.label : null;
    const sinceAt = isRecord(cache.pointer.trustInfo) ? cache.pointer.trustInfo.sinceAt : undefined;   // when the home changed: the window says "moved 11/12" only when the server gave it
    // a revert asked on the computer the connection was changed AWAY from goes back to THIS computer (`trustInfo.fromHome`): the window says "this desktop" instead of "the previous desktop".
    const fromHome = isRecord(cache.pointer.trustInfo) && isRecord(cache.pointer.trustInfo.fromHome) ? cache.pointer.trustInfo.fromHome : null;
    const fromHere = kind === "revertHome" && fromHome?.kind === "desktop" && typeof fromHome.hostId === "string" && fromHome.hostId === loadRecord(session.userId)?.hostId;
    return confirm.request(kind, { epoch: sinceEpoch, label: homeLabel, ...(sinceAt !== undefined ? { at: sinceAt } : {}), ...(fromHere ? { fromHere: true } : {}), ...(typeof fromHome?.label === "string" && fromHome.label ? { fromLabel: fromHome.label } : {}) }, async () => {
      const s = account(); const key = s ? keyed(s.userId) : null;
      if (!s || !key) return { ok: false, code: "sign_in_required" };
      if (!cache || cache.pointer.homeTrust !== "unconfirmed" || cache.pointer.epoch !== sinceEpoch) return { ok: false, code: "request_changed" };
      const route = kind === "confirmHome" ? "confirm" : "revert";
      const out = await post(route, "kid", {}, s, key);
      // no answer: the pointer says whether the decision was made (a confirm: confirmed; a revert: the epoch moved and it is confirmed again).
      if (!out.ok && noAnswer(out)) {
        const stands = (): boolean => !!cache && cache.userId === s.userId && cache.pointer.homeTrust === "confirmed" && (kind === "confirmHome" || cache.pointer.epoch !== sinceEpoch);
        if (await settledByPointer(s, stands, SETTLE_READS)) { afterDecision(kind, s.userId); return { ok: true }; }
      }
      // Audit 62 (pointer §19.6): "it was me" needs a sign-in from the last 15 minutes when no older strong key can confirm: the server answers `reauth_required` (`maxAgeSeconds: 900`) WITHOUT using anything up. The press is held (the existing
      // `pendingReauth` road: [sign in again]) and the SAME call is made again after the sign-in.
      if (!out.ok && out.code === "reauth_required") {
        held = { actionId: randomBytes(9).toString("base64url"), kind: "move", userId: s.userId, createdAt: deps.now(), retried: false, retry: async () => {
          // Desktop E2E-1 (D4): the retry runs AFTER the owner signed in again, and the sign-in that was asked for is the whole point of it. It used to send the call with `s`, the session captured BEFORE that sign-in (its cookie is the old one,
          // its sign-in time is before the change), so the server answered `reauth_required` again and the second press was the only way through. The session is read again here; another account, or none, is no retry.
          const s2 = account(); if (!s2 || s2.userId !== s.userId) return { ok: false, code: "sign_in_required" };
          const k2 = keyed(s2.userId); if (!k2) return { ok: false, code: "no_device_key" };
          const again = await post(route, "kid", {}, s2, k2); if (!again.ok) return { ok: false, code: again.code };
          await readOnce(s2); afterDecision(kind, s2.userId); return { ok: true };
        } };
        return { ok: false, code: "reauth_required", actionId: held.actionId };
      }
      // Audit 59 F-18 (web 11-12k §17.5): a revert that puts the server fence again can answer 503 `server_fence_failed` / `server_fence_unavailable` with the pointer unchanged: a machine state the screen reads as "try again".
      if (!out.ok) return { ok: false, code: out.code, ...closedReason(out), ...(out.code === "server_fence_failed" || out.code === "server_fence_unavailable" ? { retryable: true } : {}) };
      await readOnce(s);   // a revert made the pointer name the old home again: reconcile() reads it
      afterDecision(kind, s.userId);
      return { ok: true };
    });
  }
  // ── "Start here" (design 5.8.9, O-M4b): a `takeover` claim against a living home on another computer ──
  /**
   * The claim is made with this computer's own key (the body names the host and the key, signed by that key; the server wants a sign-in from the last 15 minutes). It changes nothing by itself: the living home refuses it by itself
   * (afterRead), a trusted key approves it, or the wait ends and the home becomes `unconfirmed`. The owner window only REQUESTS; the run is the confirmation window's yes (the kind is
   * screen-checked: it is not in SCREEN_CHECK_SKIPPED_KINDS). What this computer holds stays as it is: nothing is sealed, packed or sent here.
   */
  function requestStartHere(): { ok: boolean; code?: string; requestId?: string } {
    const session = account(); if (!session) return { ok: false, code: "sign_in_required" };
    if (!cache || cache.userId !== session.userId || writesClosed || pointerGone) return { ok: false, code: "one_home_unavailable" };
    if (!writesOpen()) return { ok: false, code: "device_proof_unavailable" };
    if (!deps.keyStore.available()) return { ok: false, code: "key_storage_unavailable" };
    const pointer = cache.pointer;
    if (pointer.home.kind !== "desktop") return { ok: false, code: "home_is_server" };   // a server home is left with [move here]
    const record = loadRecord(session.userId);
    if (record && pointer.home.hostId === record.hostId && !!record.pub && pointer.pub === record.pub) return { ok: false, code: "already_home" };
    if (record?.move) return { ok: false, code: "move_in_progress" };
    const seenEpoch = pointer.epoch;
    return confirm.request("takeover", { label: typeof pointer.home.label === "string" ? pointer.home.label : null, epoch: seenEpoch }, () => runStartHere(seenEpoch));
  }
  async function runStartHere(seenEpoch: number): Promise<{ ok: boolean; code?: string; actionId?: string }> {
    const session = account(); if (!session) return { ok: false, code: "sign_in_required" };
    if (!cache || cache.userId !== session.userId || writesClosed || pointerGone) return { ok: false, code: "one_home_unavailable" };
    if (!writesOpen()) return { ok: false, code: "device_proof_unavailable" };
    if (cache.pointer.epoch !== seenEpoch || cache.pointer.home.kind !== "desktop") return { ok: false, code: "request_changed" };   // the home changed after the owner looked: nothing is claimed
    const made = ensureKey(session.userId);
    if ("code" in made) return { ok: false, code: made.code };
    const label = deps.computerLabel();
    const out = await post("takeover", "host", { expectEpoch: seenEpoch, pub: made.pub, ...(label ? { label } : {}) }, session, made);
    // no answer (a slow server, a cut connection) or "already the home": the pointer says whether the request went through - it is a failure only when it did not.
    if (!out.ok && (noAnswer(out) || out.code === "already_home")) {
      const stands = (): boolean => {
        const p = cache && cache.userId === session.userId ? cache.pointer : null;
        if (!p) return false;
        if (p.home.kind === "desktop" && p.home.hostId === made.hostId && p.pub === made.pub) return true;               // the takeover took effect
        return p.claims.some((c) => c.kind === "takeover" && isRecord(c.to) && c.to.pub === made.pub);                // or it stands as this computer's claim
      };
      if (await settledByPointer(session, stands, noAnswer(out) ? SETTLE_READS : 1)) return { ok: true };
    }
    if (out.ok) {
      // Security follow-up T1: nothing is written to `seenHomes` here. [Start here] consents to "this computer becomes the home", not to vouching for the home that is pushed out: an attacker's computer
      // that waited its way in would otherwise become a "known sender" and its old records would merge without a question. The pushed-out home's old records go through the owner's [merge] window.
      // `seenHomes` is written only by: (1) home-move.ts receiver commit (fromHostId + senderPub of a verified computer-to-computer move the owner approved on the old home),
      // (2) home-move.ts sender `left` (the pinned receiver the owner pressed [move] for, boxSig verified), (3) home-leftover.ts requestSend (the owner's [send] in the confirmation window).
      return { ok: true };
    }
    if (out.code === "reauth_required") {
      held = { actionId: randomBytes(9).toString("base64url"), kind: "move", userId: session.userId, createdAt: deps.now(), retried: false, retry: async () => { const s2 = account() ?? session; await readOnce(s2); return runStartHere(cache?.pointer.epoch ?? seenEpoch); } };   // D4 (desktop E2E-1): the session read again after the sign-in (runStartHere reads it again itself)
      return { ok: false, code: "reauth_required", actionId: held.actionId };
    }
    return { ok: false, code: out.code };
  }

  /** Security review N4: the number this computer's OWN request is compared by is drawn in the confirmation window only (view-only: no yes, no screen-control check). */
  function requestShowCode(): { ok: boolean; code?: string; requestId?: string } {
    const session = account(); if (!session) return { ok: false, code: "sign_in_required" };
    const key = keyed(session.userId); const pointer = cache && cache.userId === session.userId ? cache.pointer : null;
    if (!key || !pointer) return { ok: false, code: "one_home_unavailable" };
    const mv = isRecord(pointer.move) ? pointer.move : null; const to = mv && isRecord(mv.to) ? mv.to : null;
    const claim = pointer.claims.find((c) => c.kind === "receive" && isRecord(c.to) && c.to.pub === key.pub);
    const value = mv && to && to.pub === key.pub && typeof mv.moveId === "string" ? mv.moveId : claim && typeof claim.claimId === "string" ? claim.claimId : null;
    if (!value) return { ok: false, code: "no_request" };
    return confirm.request("showCode", { confirmCode: confirmCode(value, key.pub), computer: deps.computerLabel() ?? null }, () => ({ ok: false, code: "view_only" }));
  }

  /**
   * TR-desktop (contracts/trust-root.md section 3, E1): "is THIS computer the confirmed home right now" - the same standing the mirror signs with (`standing`: a read
   * pointer, writes open, this host's key named by the pointer, no move in flight, not an unconfirmed claim), plus the host id the record carries. Memory and one
   * `meta` read, no request; it asks nothing of the server. Closed words only (`why` is the mirror's own refusal word).
   */
  function workStanding(): { ok: true; hostId: string } | { ok: false; why: string } {
    const standing = mirrorPorts.standing();
    if (!standing.ok) return { ok: false, why: standing.why };
    const session = deps.session();
    const record = session ? loadRecord(session.userId) : null;
    return record ? { ok: true, hostId: record.hostId } : { ok: false, why: "no_device_key" };
  }
  /**
   * TR-desktop 4 (M1): is a pointer read due for the work sweeps (`companion-computer-gate.ts computerStandingForSweep`)? Only for a computer that believes it is the home and is signed in: its pointer is missing (the first read failed, offline at the start)
   * or older than the window. A computer that is not the home, signed out, or in a move asks nothing. A pointer the server answered "gone" (404) is asked again after the window only (an answer is not a failure). Memory only, no request.
   */
  function standingReadDue(): boolean {
    const session = deps.session(); if (!session) return false;
    if (loadRecord(session.userId)?.state !== "home") return false;
    const standing = workStanding();
    if (!standing.ok && standing.why !== "no_pointer") return false;
    if (pointerGone || lastReadStatus === 404) return !lastAttemptAt || deps.now() - lastAttemptAt >= STANDING_READ_WINDOW_MS;
    return !cache || cache.userId !== session.userId || deps.now() - cache.readAt >= STANDING_READ_WINDOW_MS;
  }
  /** TR-desktop 4: how old the pointer held for the signed-in account is (null: none held). Memory only. */
  function pointerAgeMs(): number | null {
    const session = deps.session();
    return cache && session && cache.userId === session.userId ? Math.max(0, deps.now() - cache.readAt) : null;
  }
  /** TR-desktop 4: how long no pointer has been read (the account change or this process's start counts as the beginning). A taken Work whose computer could not read it for a whole day ends like one that is not the home (`startWaitEnded`). */
  const pointerUnreadMs = (): number => Math.max(0, deps.now() - lastGoodReadAt);
  /** TR-desktop: may THIS pairing record vouch (a screen-QR pairing or the owner's own press)? Read from the record on disk each time, so a revoked pairing is gone at once. */
  const phoneVouch = (deviceId: string): "eligible" | "owner_press_needed" | "not_eligible" => vouchOf(deps.pairing()?.phoneTrustRecord(deviceId) ?? null);

  return {
    workStanding, phoneVouch, standingReadDue, pointerAgeMs, pointerUnreadMs,
    mover, leftover, hasMove: () => !!deps.move, writeRefusal, staleKick, requestStartHere, requestClaimDecision, requestHomeDecision, requestShowCode, waitingList, waitingItem, requestWaitingReview, reviewList, reviewItem, reviewDecide, waitingCheck, moveUnavailable: MOVE_UNAVAILABLE,
    causeEnded, mirror, serverApps: (): ServerApps | null => serverApps, mirrorSignal: (kind: MirrorSignal) => mirror.signal(kind), refresh, register, afterInteractiveSignIn, reauth, requestTrustPhone, requestRevokeKey, requestRevokePhone, noticeShown, status, bridge, reset, forgetAccountSlot, legacyCutoff, confirm,
    /** Test and Main hook: the session may have changed (a sign-out, a renewal, another account). Memory state follows; plaintext copies go only for another account. */
    accountChanged: (): void => { account(); },
    /** Audit 61 (desktop 9): the owner SIGNED OUT (auth.ts `signOut`, before the session is cleared): the decrypted copies of a receiving move and of an old record that were not given to the engine yet are removed (fetched again by design). `userId` = the account that
     * is leaving (from the session itself); without it the account this memory belongs to. Another account's record is never touched. */
    signedOut: (userId?: string | null): void => { leaveAccount(userId ?? cacheUser); },
    /** Test hook: what the memory holds. Never used by product code. */
    _peek: () => ({ responseWait: responseWaitState(), deadlineAt, deadlineArmed: deadlineTimer !== null, writesClosed, held, sentSeen: [...sentSeen], handledClaims: [...handledClaims], phoneKeys: [...phoneKeys.keys()], cacheUser, hasCache: cache !== null }),
  };
}

export type OneHome = ReturnType<typeof createOneHome>;

// ───────────────────────── the real instance ─────────────────────────

let pairingProvider: () => OneHomePairingPort | null = () => null;
/** mobile-bridge/runtime.ts says which pairing manager is running now. */
export function setOneHomePairingProvider(provider: () => OneHomePairingPort | null): void { pairingProvider = provider; }

const changeListeners = new Set<() => void>();
/** The bridge authority subscribes: the owner changed what the phone may do, so it re-reads (the existing snapshot.updated). */
export function onOneHomeChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

let confirmHost: ConfirmHost = NO_CONFIRM_HOST;
/** The Main-owned confirmation window installs itself here when it exists (with the screens). Until then every request ends confirm_window_unavailable. */
export function setOneHomeConfirmHost(host: ConfirmHost): void { confirmHost = host; }

function realDeps(): OneHomeDeps {
  const auth = (): typeof import("../auth") => require("../auth");
  return {
    now: () => Date.now(),
    fetch: (url, init) => fetch(url, { ...init, body: init.body as BodyInit | undefined, redirect: "error", cache: "no-store" }),
    session: () => {
      try {
        const cookie = auth().getSessionCookieHeader();
        const actor = auth().getAuthenticatedActorIds();
        return cookie && actor ? { cookie, userId: actor.userId } : null;
      } catch { return null; }
    },
    baseUrl: () => auth().webBaseUrl(),
    getMeta: (key) => (require("../store/meta") as typeof import("../store/meta")).getMeta(key),
    setMeta: (key, value) => (require("../store/meta") as typeof import("../store/meta")).setMeta(key, value),
    pairing: () => pairingProvider(),
    signInAgain: () => auth().signInWithBrowser({ reauth: true }),
    hostId: () => {
      try { return (require("./host-identity") as typeof import("./host-identity")).oneNativeHostIdentity().hostId; } catch { return null; }
    },
    pairingChanged: () => { for (const listener of changeListeners) { try { listener(); } catch { /* observer only */ } } },
    // The one way a phone is cut: the settings screen's own revoke (credential and live socket), read when it is needed (the runtime imports this file, so no import at the top).
    revokePhone: (deviceId) => { try { return (require("../mobile-bridge/runtime") as typeof import("../mobile-bridge/runtime")).revokeMobileBridgeDevice(deviceId).ok; } catch { return false; } },
    screenControl: (now) => screenControlActive(now),
    keyStore: createHomeKeyStore({
      dir: () => (require("node:path") as typeof import("node:path")).join((require("../runtime-paths") as typeof import("../runtime-paths")).userDataDir(), "mobile-bridge"),
      safeStorage: () => { try { return (require("electron") as { safeStorage?: import("./home-key-store").SafeStoragePort }).safeStorage ?? null; } catch { return null; } },
    }),
    confirmHost: () => confirmHost,
    // Only the Main process opens the app database and the memory root for a move; the background service gets none (`move_unavailable`).
    ...(process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE ? { move: (require("./home-move-real") as typeof import("./home-move-real")).realMoveDeps() } : {}),
    ...(process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE ? {
      mirrorStore: () => { try { return (require("./home-mirror-real") as typeof import("./home-mirror-real")).realMirrorStore(); } catch { return null; } },
      mirrorFilesPorts: (own) => { try { return (require("./home-mirror-files-real") as typeof import("./home-mirror-files-real")).realMirrorFilesPorts({ now: () => Date.now(), ...own }); } catch { return null; } },
      serverAppsExtras: (own) => { try { return (require("./server-apps-real") as typeof import("./server-apps-real")).realServerAppsExtras(own); } catch { return null; } },
      mirrorSwitchOn: () => { try { const c = require("../memory/classification") as typeof import("../memory/classification"); return c.workspaceRulesOn() && c.memoryClassificationRules() !== null; } catch { return false; } },
    } : {}),
    computerLabel: () => {
      try {
        const text = (require("node:os") as typeof import("node:os")).hostname().replace(/[^\p{L}\p{N} \-_.'()]/gu, " ").replace(/\s+/g, " ").trim();
        return Array.from(text).slice(0, 32).join("").trim() || undefined;
      } catch { return undefined; }
    },
  };
}

/** The personal agent's write gate (contract §3.2): `one_sealed` / `one_away` or null. Called before a send and before a check-in review starts. */
export function oneWriteRefusal(): "one_sealed" | "one_away" | null { return oneHome().writeRefusal(); }
/** The start of a personal-agent turn: one pointer read when the last is older than 10 minutes and this computer is not `legacy`. */
export function oneHomeTurnStart(): void { oneHome().staleKick(); }

let instance: OneHome | null = null;
export function oneHome(): OneHome { return (instance ??= createOneHome(realDeps())); }

// ───────────────────────── IPC (Main) ─────────────────────────

interface IpcLike { handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void }

const onlyKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  isRecord(value) && Object.keys(value).every((k) => keys.includes(k));

/** What Main knows about senders (main.ts builds it). */
export interface OneHomeIpcHost {
  /** The owner window's main frame, a trusted renderer URL, and not an app-control call (the same test as the other owner IPC, main.ts:2965). */
  isOwnerSender(event: unknown): boolean;
  /** The owner window that sent this is shown on screen right now (visible and not minimized). Focus is not required. */
  ownerWindowShown(event: unknown): boolean;
}

/**
 * The channels of contracts/one-home-desktop.md §8, and the signals that drive a read. Called once from Main. Every owner channel refuses any other sender
 * (throws, like the other owner IPC). `oneHome:requestTrustPhone` and `oneHome:requestRevokeKey` only ask for a confirmation; the three `oneHome:confirm*`
 * channels answer the Main-owned confirmation window and nobody else. The app-control policy denies `oneHome.*` and leaves it out of the model's catalog.
 */
export function registerOneHomeIpc(ipc: IpcLike, host: OneHomeIpcHost): void {
  const home = oneHome();
  home.legacyCutoff(); // the marker that tells an old pairing record from a new one is written at the first start of this version
  const owner = (event: unknown): void => { if (!host.isOwnerSender(event)) throw new Error("untrusted-one-home-sender"); };
  ipc.handle("oneHome:status", (event) => { owner(event); return home.status(); });
  ipc.handle("oneHome:refresh", async (event, input: unknown) => {
    owner(event);
    if (!onlyKeys(input, ["reason"]) || input.reason !== "screen") return { ok: false, code: "invalid_args" };
    return home.refresh("screen");
  });
  ipc.handle("oneHome:registerDevice", async (event, input: unknown) => {
    owner(event);
    if (input !== undefined && !(isRecord(input) && Object.keys(input).length === 0)) return { ok: false, code: "invalid_args" };
    return home.register(true);
  });
  ipc.handle("oneHome:reauth", async (event, input: unknown) => {
    owner(event);
    if (!onlyKeys(input, ["actionId"]) || typeof input.actionId !== "string" || input.actionId.length > 64) return { ok: false, code: "invalid_args" };
    return home.reauth(input.actionId);
  });
  ipc.handle("oneHome:noticeShown", async (event, input: unknown) => {
    owner(event);
    if (!host.ownerWindowShown(event)) return { ok: false, code: "window_not_shown" };
    if (!onlyKeys(input, ["ids"])) return { ok: false, code: "invalid_args" };
    return home.noticeShown(input.ids);
  });
  ipc.handle("oneHome:requestTrustPhone", (event, input: unknown) => {
    owner(event);
    if (!onlyKeys(input, ["deviceId"]) || typeof input.deviceId !== "string" || !/^device_[a-f0-9]{32}$/.test(input.deviceId)) return { ok: false, code: "invalid_args" };
    return home.requestTrustPhone(input.deviceId);
  });
  ipc.handle("oneHome:requestRevokeKey", (event, input: unknown) => {
    owner(event);
    if (!onlyKeys(input, ["kid"]) || typeof input.kid !== "string") return { ok: false, code: "invalid_args" };
    return home.requestRevokeKey(input.kid);
  });
  // ── the move (contract one-home-move.md §5). Owner-window channels ask or do what hands over no power; the five that pass power only REQUEST (confirmation window runs them). ──
  const idArg = (input: unknown, key: string): string | undefined | null => {
    if (input === undefined) return undefined;
    if (!isRecord(input) || !Object.keys(input).every((k) => k === key || k === "keep" || k === "count")) return null;
    const v = input[key]; return v === undefined ? undefined : typeof v === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : null;
  };
  ipc.handle("oneHome:startMoveHere", async (event, input: unknown) => {
    owner(event);
    if (input !== undefined && !(isRecord(input) && Object.keys(input).length === 0)) return { ok: false, code: "invalid_args" };
    if (!home.hasMove()) return home.moveUnavailable;
    return home.mover.startMoveHere();
  });
  // Audit 59 F-1: "the home's key is not the one I wrote down" - the owner's answer. A request only (the yes is the confirmation window's, kind `acceptHomeKey`, screen-checked like the others).
  ipc.handle("oneHome:acceptHomeKey", (event, input: unknown) => {
    owner(event);
    if (input !== undefined && !(isRecord(input) && Object.keys(input).length === 0)) return { ok: false, code: "invalid_args" };
    if (!home.hasMove()) return home.moveUnavailable;
    return home.mover.requestAcceptHomeKey();
  });
  ipc.handle("oneHome:cancelMove", async (event, input: unknown) => {
    owner(event);
    const moveId = idArg(input, "moveId"); if (moveId === null) return { ok: false, code: "invalid_args" };
    if (!home.hasMove()) return home.moveUnavailable;
    return home.mover.cancelMove({ moveId });
  });
  ipc.handle("oneHome:answerProfile", (event, input: unknown) => {
    owner(event);
    if (!isRecord(input) || idArg(input, "moveId") === null) return { ok: false, code: "invalid_args" };
    return home.mover.answerProfile(input.keep);
  });
  ipc.handle("oneHome:approveMove", (event, input: unknown) => {
    owner(event);
    const moveId = idArg(input, "moveId"); if (moveId === null) return { ok: false, code: "invalid_args" };
    if (!home.hasMove()) return home.moveUnavailable;
    return home.mover.requestApproveMove({ moveId });
  });
  ipc.handle("oneHome:declineMove", async (event, input: unknown) => {
    owner(event);
    const moveId = idArg(input, "moveId"); if (moveId === null) return { ok: false, code: "invalid_args" };
    if (!home.hasMove()) return home.moveUnavailable;
    return home.mover.declineMove({ moveId });
  });
  ipc.handle("oneHome:confirmBlank", (event, input: unknown) => {
    owner(event);
    const moveId = idArg(input, "moveId");
    if (moveId === null || !isRecord(input) || !Number.isSafeInteger(input.count)) return { ok: false, code: "invalid_args" };
    return home.mover.confirmBlank({ count: input.count, moveId });
  });
  ipc.handle("oneHome:requestShowCode", (event) => { owner(event); return home.requestShowCode(); });
  ipc.handle("oneHome:approveClaim", (event, input: unknown) => { owner(event); return onlyKeys(input, ["claimId"]) ? home.requestClaimDecision("approveClaim", input.claimId) : { ok: false, code: "invalid_args" }; });
  ipc.handle("oneHome:rejectClaim", (event, input: unknown) => { owner(event); return onlyKeys(input, ["claimId"]) ? home.requestClaimDecision("rejectClaim", input.claimId) : { ok: false, code: "invalid_args" }; });
  ipc.handle("oneHome:startHere", (event, input: unknown) => {
    owner(event);
    if (input !== undefined && !(isRecord(input) && Object.keys(input).length === 0)) return { ok: false, code: "invalid_args" };
    return home.requestStartHere();
  });
  // ── the leftover (home-leftover.ts). [send] and [merge] only REQUEST (the yes is the Main confirmation window's); the blank count and "forget" are owner-window answers that hand over no power. ──
  ipc.handle("oneHome:sendLeftover", (event, input: unknown) => {
    owner(event);
    if (input !== undefined && !(isRecord(input) && Object.keys(input).length === 0)) return { ok: false, code: "invalid_args" };
    if (!home.hasMove()) return home.moveUnavailable;
    return home.leftover.requestSend();
  });
  ipc.handle("oneHome:mergeLeftover", (event, input: unknown) => {
    owner(event);
    if (!onlyKeys(input, ["kid"])) return { ok: false, code: "invalid_args" };
    if (!home.hasMove()) return home.moveUnavailable;
    return home.leftover.requestMerge({ kid: input.kid });
  });
  // (Audit 59 B1: `oneHome:confirmLeftoverBlank` is gone: the old-record road takes no stamp, so nothing is blanked and nothing is asked.)
  // Audit 59 B3: forgetting is asynchronous (the engine deletes the lines by id): the answer comes when it is done; the status value `leftover.receiver.forgetting` says { kid, done, total } meanwhile.
  ipc.handle("oneHome:forgetLeftoverFrom", (event, input: unknown) => {
    owner(event);
    if (!onlyKeys(input, ["kid"])) return { ok: false, code: "invalid_args" };
    if (!home.hasMove()) return home.moveUnavailable;
    return home.leftover.forgetFrom({ kid: input.kid });
  });
  // MT (contracts/mirror-trust.md section 4) + screens ga-1: the owner window asks for the review window (a request: no word of what waits comes back) and may ask whether the list can be read now (a yes/no).
  // The list, the full text of one long item and the answer are the review window's own channels below.
  ipc.handle("oneHome:reviewWaiting", (event, input: unknown) => {
    owner(event);
    if (input !== undefined && !(isRecord(input) && Object.keys(input).length === 0)) return { ok: false, code: "invalid_args" };
    return home.requestWaitingReview();
  });
  ipc.handle("oneHome:waitingCheck", (event, input: unknown) => {
    owner(event);
    if (input !== undefined && !(isRecord(input) && Object.keys(input).length === 0)) return { ok: false, code: "invalid_args" };
    return home.waitingCheck();
  });
  ipc.handle("oneHome:confirmHome", (event) => { owner(event); return home.requestHomeDecision("confirmHome"); });
  ipc.handle("oneHome:revertHome", (event) => { owner(event); return home.requestHomeDecision("revertHome"); });
  // The confirmation window only (home-confirm.ts checks the sender is that window's own webContents).
  ipc.handle("oneHome:confirmView", (event) => home.confirm.view(event));
  ipc.handle("oneHome:confirmApprove", (event, input: unknown) => home.confirm.approve(event, isRecord(input) ? input.requestId : undefined, isRecord(input) ? input.answer : undefined));
  ipc.handle("oneHome:confirmCancel", (event, input: unknown) => home.confirm.cancel(event, isRecord(input) ? input.requestId : undefined));
  // The review window (kind reviewWaiting) only: the list as text, one long text whole, and the answer over a selection (home-confirm.ts `session()` checks the sender and the live request first).
  ipc.handle("oneHome:confirmWaitingList", (event, input: unknown) => home.reviewList(event, input));
  ipc.handle("oneHome:confirmWaitingItem", (event, input: unknown) => home.reviewItem(event, input));
  ipc.handle("oneHome:confirmWaitingDecide", (event, input: unknown) => home.reviewDecide(event, input));
  startOneHomeSignals(home);
}

let signalsStarted = false;
/** The signals of §2: a restored sign-in (also the app start), the owner's own sign-in, wake from sleep, and a change of account. No timer. */
function startOneHomeSignals(home: OneHome): void {
  if (signalsStarted) return;
  signalsStarted = true;
  try {
    const auth = require("../auth") as typeof import("../auth");
    auth.onAuthSessionRestored(() => { void home.refresh("restore").catch(() => undefined); });
    auth.onInteractiveSignIn(() => { void home.afterInteractiveSignIn().catch(() => undefined); });
    auth.onAuthSessionOwnershipChanged(() => home.accountChanged());
    auth.onExplicitSignOut?.((userId) => home.signedOut(userId));   // auth.ts emits this one BEFORE the ownership signal: the memory still knows the account
  } catch { /* no auth in this process: nothing to listen to */ }
  try {
    // TG: the mirror's own signals. A Personal line written, replaced or forgotten; a personal-agent turn that ended; the profile saved. Each runs the mirror once (a run with nothing to send makes no request).
    (require("../memory/memory-written-signal") as typeof import("../memory/memory-written-signal")).onMemoryRowsChanged(() => { void home.mirrorSignal("memory").catch(() => undefined); });
    onHomeCauseEnded((cause) => { if (cause === "personal_agent") void home.mirrorSignal("turn").catch(() => undefined); });
    // E2E-2: the background service hosts the personal agent's turns, so the end of one is committed by ANOTHER process and `homeCauseEnded` (process-local) never ran here: the answer waited on this
    // computer until some other signal read the pointer (140 s measured). Main's data_version watch hears that commit; the supervisor's receipt log says which request ended. The same signal, no timer.
    const foreignEnds = (require("./personal-request-ends") as typeof import("./personal-request-ends")).foreignPersonalRequestEnds();
    foreignEnds.onEnded(() => homeCauseEnded("personal_agent"));
    foreignEnds.start();
    // Same root, the memory lines: the curator that writes the Personal lines after a turn runs in that other process too, and its `onMemoryRowsChanged` never reaches this one. Another process's write is told to the mirror
    // through the same "memory" signal (one/foreign-memory-rows.ts: the store's write mark, read once per foreign commit; this process's own writes already signal and are not signalled twice).
    const foreignRows = (require("./foreign-memory-rows") as typeof import("./foreign-memory-rows")).foreignMemoryRows();
    foreignRows.onChanged(() => { void home.mirrorSignal("memory").catch(() => undefined); });
    foreignRows.start();
    (require("../store/change-bus") as typeof import("../store/change-bus")).onDesktopStoreChange((change) => { if (change.entity === "one-profile") void home.mirrorSignal("profile").catch(() => undefined); });
  } catch { /* a module that is not loaded here holds nothing to listen to */ }
  try {
    // Audit 62 (home D2): the ends of the causes a move waits for are signals too (the supervisor store and dreaming say so through home-signal.ts; the memory-move gate going idle is the engine's end).
    onHomeCauseEnded(() => home.causeEnded());
    (require("../migration/gate") as typeof import("../migration/gate")).onMemoryMoveIdle(() => homeCauseEnded("engine"));
  } catch { /* the gate module is not loaded here: the other signals remain */ }
  try {
    const power = (require("electron") as { powerMonitor?: { on(event: string, listener: () => void): void } }).powerMonitor;
    power?.on("resume", () => { void home.refresh("wake").catch(() => undefined); });
  } catch { /* not an Electron process */ }
}

/** The window of "something operated the screen" (re-exported so a gate can assert it is the computer-use scope's own value). */
export const ONE_HOME_SCREEN_CONTROL_WINDOW_MS = SCREEN_CONTROL_WINDOW_MS;
