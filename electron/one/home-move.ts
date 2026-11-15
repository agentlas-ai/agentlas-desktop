/*
 * The first move of the personal agent: this computer's step machine (Agentlas 2.0 O-M3b, contracts/one-home-move.md §3).
 * Plain module, no Electron import: `home.ts` builds it with a context (`MoveCtx`: the account, the pointer, signed calls, the local record) and `MoveDeps` (the
 * stores, the engine caller, the directories, the secrets). A gate drives the same code with synthetic homes and a fake server.
 *
 * Rules kept here (each has a gate in scripts/test-one-home-m3b.cjs):
 * - Nothing runs by itself: a step runs on a signal (a pointer read, an owner press). No timer, no pointer polling - with ONE exception (`awaitingResponse`): a receiver that waits for a person on another device to answer its request. A step that has to wait ends its pass with a code.
 *  - The local `move.step` is written AFTER the step's work and every work is idempotent, so a kill -9 anywhere ends in the same place when the app is opened again.
 *  - A pointer answer that is not 200 never changes local state; another computer's pending request never changes it either (local state changes only with a committed epoch).
 *  - A move belongs to one account: another account's session never continues it.
 *  - The plaintext export of the server's copy lives in `stagingBase/<moveId>/export/` and is deleted (absence re-read) at the end, on cancel, on expiry and when the server says `no_such_move`.
 *  - Counts and codes go to the screen; text from the server or from a bundle never does, and never into a prompt, a tool result or a log.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { BLANK_CONFIRM_ABOVE, BUNDLE_FILES, BUNDLE_LEGACY_LIMIT_BYTES, BUNDLE_LIMIT_BYTES, memoryRoomBytes, boundPersonalChat, checkStaged, describeLeftBehind, discardPacked, discardStaged, importStaged, measureOne, packOne, purgePacked, readyOne, stageBundle, type BundleHost, type OnePackCaller, type ReadyBlocker } from "./bundle";
import { readWait } from "./home-pointer-read";
import { fileSha, removePartial } from "./bundle-stream";
import { BUNDLE_WIRE_MAX, boxPubFromSeed, generateBoxKeyPair, maskId, openBundle, openBundleFile, sealBundle, signBoxPub, verifyBoxSig } from "./transport";
import { applyHandedBack, type BundleSources } from "./bundle-host";
import { applyServerExport, EXPORT_SECTIONS, exportDirOf, moveFolderOf, markSectionDone, planServerFacts, planServerMessages, readSection, removeExportDir, resetSection, sectionDone, writeExportPage,
  type ExportSection, type FactWrite, type FactOutcome, type LocalProfileView, type ProfilePatch, type ProfilePlan } from "./server-import";
import type { MoveSecretStore } from "./home-key-store";
/** The conductor's open code while the agent folder step cannot run because the chosen folder is not there (`first_run:` + the folder pass's `skipped` word `root-missing`: migration/first-run.ts, agents/home-move.ts). */
const AGENT_FOLDER_MISSING_OPEN_CODE = "first_run:root-missing";
import type { ConfirmGate } from "./home-confirm";
import type { LeftoverDeps } from "./home-leftover";

export type MoveRole = "receiver" | "sender";
export type MoveOrigin = "server" | "desktop";
export type MoveStep = "claimed" | "requested" | "sealed" | "fetched" | "checked" | "committed" | "imported" | "caughtUp" | "reported"
  | "asked" | "approved" | "packed" | "uploaded" | "left" | "purged";
export type HomeState = "legacy" | "home" | "sealed" | "away";

/** Contract §3.1 `move`. Names of files, never keys. Read by: the step machine, `status`. Deleted: when the move ends (closeMove). */
export interface MoveRecord {
  moveId?: string; role: MoveRole; from: MoveOrigin; step: MoveStep; startedAt: number;
  pinned?: { moveId: string; toPub: string; boxPub: string; senderPub: string; toHostId: string };
  /** Receiver: what the engine refused to take in, already masked with K_rej (22 characters each, at most 200). Sent with `move/imported`. */
  rejected?: { count: number; ids: string[]; truncated: boolean };
  senderPub?: string; boxPub?: string;
  /** Receiver from a computer: the computer the move comes from, remembered with `senderPub` so that, once this computer is the home, that computer is one it has seen (leftover: a known sender). */
  fromHostId?: string;
  stagedDir?: string; packDir?: string; packId?: string; purgeIds?: string[];
  confirmBlank?: number; blankAsk?: { count: number };
  /** Sender (security follow-up S2): sha-256 of the bytes this computer locked and wrote to `<packDir>/sealed.bin`, set BEFORE the upload; `uploadedSha`: the sha-256 the pointer showed. K_rej is bound to a sha-256 (secret `krej.<16 hex>`). */
  sealedSha?: string; uploadedSha?: string;
  counts?: Record<string, number>;
  /** The last reason this move is waiting (a code the screen turns into a sentence). */
  waiting?: string;
  attempts?: number;
  approvedBy?: "owner" | "phone";
  /** Receiver from a computer: set right before `move/commit` is sent, and only when the home it comes from was `confirmed` at that moment. `seenHomes` takes the sender only when this is set. */
  fromConfirmed?: boolean;
  /** Receiver: the size and sha-256 of the locked bundle the pointer showed (its sender proof was verified before it was opened). After the commit they let this computer fetch the bundle AGAIN (the staged folder lost) and check it. */
  bundleSha?: string; bundleBytes?: number;
  /** Sender (F-3): the local purge is done (the folder is gone); only `move/purged` is left to tell. Counts of that purge are in `counts`. */
  purgeDone?: boolean;
  /** Sender (F-5): when the wait for the receiver's import / trust began (the `purged` step); past 30 days the pack folder (a copy of the text) is removed and the purge is left undone. */
  purgeWaitSince?: number;
  /** Sender: the times the same locked bytes were put again after the commit, and when the last was. */
  redeposits?: number; redepositAt?: number;
  /** Receiver (home D4): when this computer committed (the pointer's own `last.at` may be gone by then). The end of every wait after the commit is counted from here. */
  committedAt?: number;
  /** Audit D6 (receiver from the server): `caughtUp` ran out of time (the same end as a wait for the import: the server's own deadline, else 7 days after the commit); the code it was waiting with. The move is told as done (`move/imported`) and closed with the word `caught_up_expired`; what was imported is all there. */
  caughtUpEnded?: string;
  /** Audit 62 (§6.1): when the move began waiting with the CURRENT `waiting` code (a screen shows "waiting since", and for how long it can last). Reset with every step. */
  waitSince?: number;
  /** Audit 62 (engine `ready`): what keeps this computer from taking the import - codes and engine host names, no path or text. `held`: the engine said calling `import` again cannot change the answer until something OUTSIDE does (`needs`): the machine asks the cheap read-only `ready` at each signal instead of `check` + `import`. */
  blocker?: ReadyBlocker & { held?: boolean };
  /** Audit 62 (pointer §19.3): a `rate_limited` answer of kind `window` says after how long to go again (`retryAfterSeconds`): the moment, so the state and the one deadline timer can name it. */
  retryAt?: number;
  /** Audit 62 / the server did not take the call because the sign-in was not a strong one (Google / Apple within 15 minutes): the claim waits (`matureAt`), a strong sign-in and the SAME call (this step, run again at the sign-in signal) ends it. Codes and a time only. */
  signinWait?: { methods: string[]; matureAt?: number };
  /** Audit 62 / the memory room (bytes) the engine was given at `measure` when the store does not fit whole (`partial_export`): `export` gets the SAME value, so the pack carries exactly what was measured (newest lines first). Absent = the whole store. */
  memoryLimit?: number;
  /** Audit 62 / the size limit THIS move packs for (100 MiB only when the engine lists `limit_100mib` and the server has not refused a big bundle) and whether the engine takes `--limit-bytes` in `check` / `import`. */
  bundleLimit?: number; engine100?: boolean;
  /** Audit 62 / the engine's `import` is running since this moment (memory is not a progress bar: a 100 MiB import took 211 s in the engine's own measurement); the screen shows "importing" and for how long. */
  importingSince?: number;
  /** Repair 5 / web E-3 (receiver from a computer): the biggest bundle this computer said it can take (`move/start` `receiverLimitBytes`; the pointer gives it back as `move.to.limitBytes`). Absent = this move was started before the field existed: the engine's own limit is used. Deleted with the move. */
  receiverLimit?: number;
  /** Repair 5 (receiver): how many times this chain of moves was started again under a smaller size the engine named (`too_large` + `limitBytes`). At most `MAX_REPACKS`: the size only ever goes down, so the chain ends. */
  repacked?: number;
  /** Repair 5 / web 408 (sender): how many times the put of THIS bundle ended `request_timeout` (the server's own time limit: `body_stalled` / `body_too_slow`, or this computer's drop after a long slow send). At the second the bundle is packed again at half the size (never below 8 MiB). */
  slowPuts?: number;
}
/** `waitedFor` (home D4): for a move that ended because a wait ran out (`import_expired`), the code it was waiting with. */
export interface LastMove { moveId: string; at: number; role: MoveRole; from: MoveOrigin; outcome: "done" | "cancelled" | "expired" | "replaced" | "stopped"; code?: string; counts?: Record<string, number>; waitedFor?: string }
export interface SeenHome { hostId: string; pub: string }
/** The personal conversation as it was before this computer left the home (read-only "conversation before the move"). Read by: `status().away`. Deleted: when this computer is the home again. */
export interface BeforeMove { chatId: string; at: number }
export interface HomeRecordView {
  state: HomeState; hostId: string; pub?: string; kid?: string; epoch?: number; homeLabel?: string; seenHomes?: SeenHome[]; move?: MoveRecord; lastMove?: LastMove; beforeMove?: BeforeMove;
  /** Leftover (O-M4b, home-leftover.ts): the old records of an `away` computer, and what a home computer has merged. Their shapes live there. */
  leftover?: unknown; leftoverBox?: unknown; leftoverDone?: unknown; leftoverWork?: unknown; leftoverOk?: unknown;
  /** The `hardenAt` (ms) of the unconfirmed connection the owner was already told about, 7 days before it confirms itself (home-harden-notice.ts). Read by: that one decision. Erased: when the connection is confirmed, reverted or changed. */
  hardenTold?: number;
  /** Key cuts the owner confirmed whose server half is still owed (home-revoke-owed.ts has the rule: readers, erasure). */
  revokeOwed?: Array<{ kid: string; at: number }>;
}

export interface PointerMoveView { moveId?: string; phase?: string; from?: { kind?: string; hostId?: string }; to?: { hostId?: string; pub?: string; label?: string; boxPub?: string; boxSig?: string; /** repair 5 / web E-3: what the receiving computer said it can take (absent = it said nothing: an older computer) */ limitBytes?: number }; startedAt?: number; expiresAt?: number; expired?: boolean; bytes?: number; sha256?: string; senderPub?: string; uploadProof?: { ts?: unknown; nonce?: unknown; sig?: unknown }; approved?: boolean; approvedBy?: string; waited?: boolean }
export interface PointerLike {
  home: { kind: "server" } | { kind: "desktop"; hostId: string; label?: string };
  pub: string | null; epoch: number; homeTrust: "confirmed" | "unconfirmed";
  claims: Array<Record<string, unknown>>;
  move?: unknown; last?: unknown;
  [key: string]: unknown;
}
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
const pmove = (p: PointerLike | null): PointerMoveView | null => (p ? rec(p.move) as PointerMoveView | null : null);
export interface ImportedProof { hostId: string; ts: number; nonce: string; sig: string; sent: string[] }
const plast = (p: PointerLike | null): { moveId?: string; mode?: string; importedAt?: string | null; purgedAt?: string | null; rejectedIds?: string[]; rejected?: number; rejectedIdsTruncated?: boolean; importedProof?: ImportedProof; bundleHeld?: boolean } | null => (p ? rec(p.last) : null);
/** When this move was committed, as the pointer's last act says (this move's own act only); without it, the start plus the request's 24 hours (the commit cannot be earlier than the start). */
const commitTimeOf = (last: { moveId?: string; at?: unknown } | null, m: { moveId?: string; startedAt: number }): number => {
  const raw = last && last.moveId === m.moveId ? last.at : undefined;
  const at = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(at) ? at : m.startedAt + 24 * 3_600_000;
};

export interface Session { cookie: string; userId: string }
export type CallOut = { ok: true; result: string; body: Record<string, unknown> } | { ok: false; code: string; status?: number; unreachable?: boolean; retryable?: boolean; body?: Record<string, unknown> | null };

export interface MoveDirs { workDir: string; stagingBase: string }
export interface ReadinessFacts {
  hostId: string | null; runtimeCount: number | null; classified: boolean | null; rulesOn: boolean | null; labelsRunning: boolean | null;
  diskFreeBytes: number | null; cloudComputer: boolean;
  /** Audit 62 (home D7): why the first-run migration has not classified: its switch is off (`false`), or it ran and stopped (`migrationOpenCodes`). `undefined` = not read. */
  migrationEnabled?: boolean | null; migrationOpenCodes?: string[];
}
export interface MoveDeps {
  dirs(userId: string): MoveDirs;
  secrets: MoveSecretStore;
  caller(): OnePackCaller;
  bundleHost(userId: string): BundleHost;
  /** The same sources the bundle host is made of (the handed-back profile, avatar and settings are applied through them). */
  sources(): BundleSources;
  readiness(): Promise<ReadinessFacts>;
  /** The five conditions of design 5.8.7, read from this computer's own state. `ok:false` carries the first one that does not hold. */
  resting(): { ok: boolean; why?: string };
  activeWorkCount(): number;
  localProfile(): LocalProfileView;
  applyProfile(patch: ProfilePatch): void;
  writeFact(fact: FactWrite): FactOutcome;
  /** TH+MT F2: link the words just taken to the server turns they were said in (server-turns.ts). */
  noteTurns?(pairs: Array<{ id: string; turnId: string }>): void;
  /** TH+MT: "one more take" of a server-start move - the mirror's ordinary take (gone, profile, facts, messages, acknowledgements) with no send. `ok` false carries the mirror's closed word; a failure is asked again (every id is idempotent). Absent = the step is passed (a gate without a mirror). */
  catchUp?(): Promise<{ ok: boolean; code?: string }>;
  /** TH: a server-start move ended `done` (this computer is the home and has caught up): the first upload of the mirror runs now (a signal, never a wait). */
  afterDone?(): void;
  plantContextSeed(packId: string, turns: Array<{ role: "user" | "assistant"; text: string; createdAt: string }>): boolean;
  ensurePersonalChat(): string | null;
  unbindPersonalChat(): void;
  engineRoots(): string[];
  /** The mirror in the root store (`memory_store_meta.one_home_state`). null = legacy (key removed). Returns false when it could not be written. */
  setMirror(state: HomeState): boolean;
  getMirror(): string | null;
  /** Pause between retries of a busy answer (a gate passes 0). Not a timer: one await. */
  pauseMs?: number;
  /** Test seam: throws at a named point to model a kill -9 there. */
  crash?(point: string): void;
  /** The leftover's own ports (O-M4b, home-leftover.ts). Absent = leftover does nothing here. */
  leftover?: LeftoverDeps;
}

export interface MoveCtx {
  now(): number;
  account(): Session | null;
  pointer(): PointerLike | null;
  keyed(userId: string): (HomeRecordView & { privateKey: string; pub: string; kid: string }) | null;
  ensureKey(userId: string): (HomeRecordView & { privateKey: string; pub: string; kid: string }) | { code: string };
  load(userId: string): HomeRecordView | null;
  save(userId: string, record: HomeRecordView): void;
  call(route: string, mode: "host" | "kid", fields: Record<string, unknown>, session: Session, record: { hostId: string; privateKey: string; kid: string }): Promise<CallOut>;
  /** One pointer GET now (never retried). */
  readPointer(): Promise<boolean>;
  writesClosed(): boolean;
  /** The SERVER shut the writes (a 503 seen, the pointer's `writes` not "open", or a 404 on the pointer): the evidence a sealed sender needs to open its own door again. An unreachable server is NOT this. */
  serverShut?(): boolean;
  /** Something operates the screen right now (`oneHome.startMoveHere` and the notices refuse then, F-10). */
  screenActive?(): boolean;
  /** The home's old-record box key goes (F-14): called when this computer leaves the home. */
  forgetHomeBox?(userId: string): void;
  /** The pointer says `writes: "open"` and this run has not seen the switch closed. Anything else: no key, no signature, no write call (`device_proof_unavailable`). */
  writesOpen(): boolean;
  holdForReauth(userId: string, retry: () => Promise<{ ok: boolean; code?: string }>): string;
  confirm: ConfirmGate;
  /** The 6-digit number of `confirmCode(serverValue, pub)` (home.ts owns the primitive). */
  confirmCode(serverValue: string, pub: string): string;
  /** The signed text of this deployment for a route (home.ts owns the primitive) and the Ed25519 check: the receiving computer verifies the sender's `move/uploaded` signature itself (contract §2.7). */
  signedText(route: string, userId: string, body: Record<string, unknown>): string;
  verify(pub: string, text: string, sig: string): boolean;
  /** `move/bundle-put`: the locked bytes as the body, the proof in the `x-one-home-proof` header. */
  putBundle(session: Session, record: { hostId: string; privateKey: string }, fields: { moveId: string; sha256: string; bytes: number }, body: Buffer | { file: string }): Promise<CallOut>;
  /** `move/bundle-get`: the bytes, or the machine code. */
  getBundle(session: Session, record: { hostId: string; privateKey: string }, moveId: string, maxBytes: number, dest?: string): Promise<{ ok: true; bytes: Buffer } | { ok: true; file: string; size: number; sha256: string } | { ok: false; code: string; unreachable?: boolean }>;
  computerLabel(): string | undefined;
  /** the owner's refusal of a request reached the server (the completion card on the main window). */
  answered?(kind: "declined"): void;
  keyStoreAvailable(): boolean;
  deps: MoveDeps;
  /** Audit 62 (home D2): a drive pass ended (home.ts re-aims its one-shot deadline timer there). */
  passEnded?(): void;
}

const MIB = 1024 * 1024;
const SEALED_FILE = "sealed.bin";
const SHA_RE = /^[a-f0-9]{64}$/;
const PUB43 = /^[A-Za-z0-9_-]{43}$/;
const krejName = (sha: string): `krej.${string}` => `krej.${sha.slice(0, 16)}`;
const MAX_ATTEMPTS = 5;
/** Repair 5: a receiver starts a move again under a smaller size at most this many times (each is strictly smaller than the one before, and never below 1 MiB, so the chain ends by itself; the number is a second fence). */
const MAX_REPACKS = 3;
const MIN_LIMIT_BYTES = MIB;
/** Repair 5: a wait the engine says ends by itself (`store_busy`) is asked again after 2 s, 4 s, 8 s ... at most every 5 minutes; the request's own expiry (24 hours) is the end. A slow upload waits 10 s, 20 s ... the same way. */
const backoffMs = (tries: number, firstMs: number): number => Math.min(firstMs * 2 ** Math.max(0, tries - 1), 5 * 60_000);
/** Audit 59 F-5: how long a sender waits (for the receiver's import and the trust) with its pack folder - a copy of the text in the clear - before the purge is left undone. */
const PURGE_WAIT_MAX_MS = 30 * 24 * 3_600_000;
/** Audit 59 B11: the server keeps a held bundle 24 hours; the sending home puts the same bytes again no sooner than that (minus an hour) after the commit, at most three times. */
const REDEPOSIT_AFTER_MS = 23 * 3_600_000;
const REDEPOSIT_MAX = 3;
/** Audit 61 desktop 3: with the server's own `bundleHeld: false` the look is not tied to the 23 hours, only throttled. */
const REDEPOSIT_RETRY_MS = 10 * 60_000;
/** Audit 61 (desktop 4): how long a receiver that has committed waits for the old home to put the held bytes again: the server's `import_pending` window (7 days after the commit, contracts/one-home-pointer.md). */
const REDEPOSIT_WAIT_MAX_MS = 7 * 24 * 3_600_000;
const MAX_PAGES = 4_000;

export function createHomeMove(ctx: MoveCtx) {
  let driving: Promise<void> | null = null;
  let rerun = false;
  /** True while a sealed sender reads the pointer to decide whether it may open: the signals that read causes must not ask for another pass (it would read again, for ever). */
  let shutReading = false;
  const crash = (point: string): void => ctx.deps.crash?.(point);
  const pause = async (): Promise<void> => { const ms = ctx.deps.pauseMs ?? 1_000; if (ms > 0) await new Promise<void>((r) => setTimeout(r, ms)); };

  // ── local record helpers ──
  function current(): { session: Session; userId: string; record: HomeRecordView; key: NonNullable<ReturnType<MoveCtx["keyed"]>> } | null {
    const session = ctx.account(); if (!session) return null;
    const key = ctx.keyed(session.userId); if (!key) return null;
    return { session, userId: session.userId, record: ctx.load(session.userId) ?? key, key };
  }
  function patchMove(userId: string, patch: Partial<MoveRecord>): HomeRecordView {
    const record = ctx.load(userId)!;
    const next: HomeRecordView = { ...record, move: { ...record.move!, ...patch } };
    ctx.save(userId, next);
    return next;
  }
  function setStep(userId: string, step: MoveStep, extra: Partial<MoveRecord> = {}): void {
    const record = ctx.load(userId)!;
    ctx.save(userId, { ...record, move: { ...record.move!, step, waiting: undefined, waitSince: undefined, retryAt: undefined, signinWait: undefined, importingSince: undefined, attempts: 0, ...extra } });
  }
  const dirsOf = (userId: string): MoveDirs => ctx.deps.dirs(userId);
  const profileAskKey = (): string => "profile-ask";

  /** The mirror follows the local record (the record is the truth): rewritten whenever they differ. A failed write is retried at the next pass. */
  function syncMirror(record: HomeRecordView): void {
    const want = record.state;
    const have = ctx.deps.getMirror();
    if (want === "legacy" ? have === null : have === want) return;
    ctx.deps.setMirror(want);
  }

  // ── the readiness check (§5.8.4): one code at a time, in this order ──
  async function readiness(): Promise<{ ok: true } | { ok: false; code: string }> {
    const session = ctx.account();
    if (!session) return { ok: false, code: "sign_in_required" };
    const facts = await ctx.deps.readiness();
    if (facts.cloudComputer) return { ok: false, code: "cloud_computer" };
    if (!ctx.keyStoreAvailable()) return { ok: false, code: "key_storage_unavailable" };
    if (!facts.hostId) return { ok: false, code: "no_host_id" };
    if (!facts.runtimeCount || facts.runtimeCount < 1) return { ok: false, code: "no_runtime" };
    // Audit 62 (home D7): the first-run migration is what classifies the memory and turns the rules on (the engine reads layout 3 for an import). With its switch OFF nothing will ever write those marks: waiting does not help,
    // so the code says so (an order of switches: first run, then the home - docs/Agentlas2.0/SWITCH-CHECKLIST.md). A run that stopped says so as well; only a run that is going names the wait.
    if (facts.classified !== true || facts.rulesOn !== true) {
      if (facts.migrationEnabled === false) return { ok: false, code: "first_run_migration_off" };
      // The agent folder the person chose is not there (an unplugged drive): its own word, because the one thing to do is different from "restart" (the conductor's open code names the cause; nothing is parsed from prose).
      if (facts.migrationOpenCodes?.includes(AGENT_FOLDER_MISSING_OPEN_CODE)) return { ok: false, code: "first_run_agent_folder_missing" };
      if (facts.migrationOpenCodes && facts.migrationOpenCodes.length) return { ok: false, code: "first_run_migration_stopped" };
    }
    if (facts.classified !== true) return { ok: false, code: "migration_not_classified" };
    if (facts.rulesOn !== true) return { ok: false, code: "rules_switch_off" };
    if (facts.labelsRunning !== false) return { ok: false, code: "first_run_labels_running" };
    if (facts.diskFreeBytes === null || facts.diskFreeBytes < 2 * BUNDLE_WIRE_MAX) return { ok: false, code: facts.diskFreeBytes === null ? "disk_unknown" : "disk_space" };
    if (!ctx.pointer() || ctx.writesClosed()) return { ok: false, code: "pointer_unavailable" };
    return { ok: true };
  }

  // ── cleanup ──
  function removeStaging(userId: string, moveId: string | undefined): boolean {
    const { stagingBase } = dirsOf(userId);
    let clean = true;
    if (moveId) clean = removeExportDir(stagingBase, moveId) && clean;
    return clean;
  }
  /** Ends the local move: the plaintext, the staged folder, the secrets; then the record. Returns true only when the absence of the plaintext was re-read. */
  async function closeMove(userId: string, outcome: LastMove["outcome"], code?: string, counts?: Record<string, number>, waitedFor?: string): Promise<boolean> {
    const record = ctx.load(userId); const move = record?.move;
    if (!record || !move) return true;
    let clean = true;
    if (move.moveId) {
      clean = removeStaging(userId, move.moveId);
      ctx.deps.secrets.removeMove(userId, "pending"); ctx.deps.secrets.removeMove(userId, move.moveId);   // every name, the sha-bound K_rej files included
      clean = !ctx.deps.secrets.existsAny(userId, move.moveId) && clean;
    }
    if (move.packDir) { discardPacked(move.packDir); clean = !fs.existsSync(move.packDir) && clean; }
    if (move.role === "sender" && record.state === "sealed" && outcome !== "done") {   // cancelled, expired, replaced or stopped before the commit: the home opens again (contract §3.3)
      const reopened: HomeRecordView = { ...record, state: "home" };
      ctx.save(userId, reopened); ctx.deps.setMirror("home"); record.state = "home";
    }
    if (move.stagedDir) { discardStaged(move.stagedDir); clean = !fs.existsSync(move.stagedDir) && clean; }
    const lastCounts = counts ? { ...(move.counts ?? {}), ...counts } : move.counts;
    const last: LastMove = { moveId: move.moveId ?? "none", at: ctx.now(), role: move.role, from: move.from, outcome, ...(code ? { code } : {}), ...(lastCounts ? { counts: lastCounts } : {}), ...(waitedFor ? { waitedFor } : {}) };
    const { move: _gone, ...rest } = ctx.load(userId) ?? record;
    ctx.save(userId, { ...rest, lastMove: last });
    try { ctx.passEnded?.(); } catch { /* the timer aim never changes the close */ }   // a move that ends takes its deadline timer with it, whichever path ended it
    return clean;
  }
  /** Restart sweep: plaintext folders and secret files of any move that is not the recorded one are removed (§3.3 last paragraph). */
  function sweep(userId: string, keepMoveId: string | null, keepStaged: string | null = null, keepPack: string | null = null): void {
    const { stagingBase, workDir } = dirsOf(userId);
    // Audit 59 F-5: a pack folder (a copy of the conversation and the Personal lines in the clear) that the record does not name - a run that died between packing and writing the record, a record that was lost -
    // goes at the start. Only this feature's own work folder (`one-move/<account>/work`, direct children: the old-record machine has its own sub-folder) and only a folder whose owner marker proves it is ours.
    try { for (const name of fs.readdirSync(workDir)) if (name.startsWith("one-pack-") && path.join(workDir, name) !== keepPack) discardPacked(path.join(workDir, name)); } catch { /* no folder yet */ }
    // Staged copies of a bundle (`one-staged-*`) that the record does not name: a run that died between a clone and its end. `discardStaged` removes only a folder whose owner marker proves it is ours.
    try { for (const name of fs.readdirSync(stagingBase)) if (name.startsWith("one-staged-") && path.join(stagingBase, name) !== keepStaged) discardStaged(path.join(stagingBase, name)); } catch { /* no folder yet */ }
    try {
      for (const name of fs.readdirSync(stagingBase)) {
        if (!/^mv_[A-Za-z0-9_-]{24}$/.test(name) || name === keepMoveId) continue;
        const full = path.join(stagingBase, name);
        try { if (fs.lstatSync(full).isDirectory()) fs.rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* retried at the next sweep */ }
      }
    } catch { /* no folder yet */ }
    ctx.deps.secrets.removeOthers(userId, keepMoveId);
  }

  // ── starting ──
  /** The owner's [move here]. Server home: a `receive` claim, then (when it can be used) the move. */
  /** The last blocker `ready` gave to [move here] (memory only; the screen reads it from `view()` and it is gone when a start succeeds). */
  let readyBlock: ReadyBlocker | null = null;
  async function startMoveHere(): Promise<{ ok: boolean; code?: string; detail?: string; needs?: string; retryable?: boolean; hosts?: string[]; actionId?: string }> {
    const session = ctx.account(); if (!session) return { ok: false, code: "sign_in_required" };
    if (ctx.screenActive?.()) return { ok: false, code: "screen_control_active" };   // F-10: a move is the owner's press on a screen nothing else is operating
    if (ctx.pointer() && !ctx.writesOpen()) return { ok: false, code: "device_proof_unavailable" };
    const pre = await readiness();
    if (!pre.ok) return { ok: false, code: "not_ready", detail: pre.code };
    // Audit 62 (home D4, engine `ready`): BEFORE anything is created or sent the engine says whether this computer can take an import at all (engine copies that do not read a bundle stamp, owner not bound, store, original-wording table).
    // A computer that cannot starts nothing: the old home stays the home; the code, what has to change outside (`needs`) and the engine hosts are on the state. An engine from before `ready` goes on as before.
    const existing0 = ctx.load(session.userId);
    if (!existing0?.move) {
      // Repair 5 (engine `ready_room`): the disk is looked at with the room a bundle of this move may need (a move from a computer: up to the size this computer would declare; from the server there is no bundle). A store a writer holds right now (`store_busy`,
      // `retryable`) is asked again - three more times, 1 / 2 / 4 pauses - before the owner is told (no timer: this is the owner's own press); anything else that is not ready is the answer at once.
      const needBytes = ctx.pointer()?.home.kind === "desktop" ? (engine100: boolean) => (engine100 ? BUNDLE_LIMIT_BYTES : BUNDLE_LEGACY_LIMIT_BYTES) : undefined;
      let rdy = await readyOne(ctx.deps.caller(), ctx.deps.engineRoots(), { needBytes });
      for (let again = 0; again < 3 && rdy.state === "not_ready" && rdy.blockers.length > 0 && rdy.blockers.every((b) => b.retryable === true); again += 1) { for (let i = 0; i <= again; i += 1) await pause(); rdy = await readyOne(ctx.deps.caller(), ctx.deps.engineRoots(), { needBytes }); }
      if (rdy.state === "not_ready") { const first = rdy.blockers[0]; readyBlock = first; return { ok: false, code: "not_ready", detail: first.reason, needs: first.needs, ...(first.retryable ? { retryable: true } : {}), ...(first.hosts ? { hosts: first.hosts } : {}) }; }
      readyBlock = null;
    }
    const existing = ctx.load(session.userId);
    if (existing?.move) { void drive(); return { ok: true, code: "already_moving" }; }
    const pointer = ctx.pointer()!;
    if (pointer.home.kind === "desktop") {
      const rec0 = ctx.keyed(session.userId);
      if (rec0 && pointer.home.hostId === rec0.hostId) return { ok: false, code: "already_home" };
      const made2 = ctx.ensureKey(session.userId);
      if ("code" in made2) return { ok: false, code: made2.code };
      ctx.save(session.userId, { ...(ctx.load(session.userId) ?? made2), hostId: made2.hostId, pub: made2.pub, kid: made2.kid, state: (ctx.load(session.userId)?.state ?? "legacy"), move: { role: "receiver", from: "desktop", step: "requested", startedAt: ctx.now() } });
      return await driveAndAnswer(session.userId);
    }
    const made = ctx.ensureKey(session.userId);
    if ("code" in made) return { ok: false, code: made.code };
    ctx.save(session.userId, { ...(ctx.load(session.userId) ?? made), hostId: made.hostId, pub: made.pub, kid: made.kid, state: (ctx.load(session.userId)?.state ?? "legacy"), move: { role: "receiver", from: "server", step: "claimed", startedAt: ctx.now() } });
    return await driveAndAnswer(session.userId);
  }

  async function driveAndAnswer(userId: string): Promise<{ ok: boolean; code?: string; actionId?: string }> {
    await drive();
    const record = ctx.load(userId);
    const w = record?.move?.waiting;
    if (w === "reauth_required") return { ok: false, code: "reauth_required", actionId: lastActionId ?? undefined };
    return { ok: true, ...(w ? { code: w } : {}) };
  }
  let lastActionId: string | null = null;
  /** Audit 62 / + repair 5: the biggest bundle (not wire bytes) the SERVER took when it last refused one (`bundle_too_large` on the put). The number is the one the server named (`limitBytes`, minus the wire's 1 MiB) or, from a server that names none (before 100 MiB took effect), the legacy 8 MiB.
   * Memory only: after a restart the first big move finds out again by one refused put and repacks - never a dead end. */
  let serverBundleCap: number | null = null;
  /** Repair 5 / web E-3: false once a `move/start` that carried `receiverLimitBytes` was refused `invalid_request` (a web from before the field): the next starts of this run leave the field out. Memory only. */
  let serverTakesLimit = true;
  /** A `retryAfterSeconds` an answer carries (`server_storage_full`, a window 429): the moment to try the SAME call again, on the move (the one deadline timer aims at it). */
  function noteRetryAfter(userId: string, out: { body?: Record<string, unknown> | null }): void {
    const secs = out.body && typeof out.body.retryAfterSeconds === "number" && Number.isFinite(out.body.retryAfterSeconds) ? Math.min(Math.max(0, out.body.retryAfterSeconds), 3_600) : null;
    if (secs !== null) patchMove(userId, { retryAt: ctx.now() + secs * 1_000 });
  }

  // ── (home D2): what ends a wait without a signal ──
  /** Codes of a wait whose cause is on THIS computer (the personal agent, dreaming, the engine, the mirror): the end of that cause is a signal (home-signal.ts). A server, a peer or the owner is not here. */
  const LOCAL_CAUSE_WAITS = new Set(["store_busy", "personal_agent_running", "dreaming_running", "resting_unknown", "not_resting", "mirror_unavailable", "measure_unavailable", "pack_failed", "import_partial", "import_remaining", "purge_remaining", "stage_failed", "native_table_failed"]);
  /** Waits the design itself sets (a delay, the other computer, the owner's answer) and waits on the outside (server, disk, key storage, the owner's plugin update): the rest are this computer's own. */
  const DESIGNED_WAITS = new Set(["waiting_approval", "waiting_redeposit", "waiting_import", "waiting_receiver", "waiting_sender", "waiting_owner", "waiting_blank_confirm", "home_unconfirmed", "new_home_not_trusted", "home_key_changed"]);
  const EXTERNAL_WAITS = new Set(["request_timeout", "server_update_pending", "disk_space_short", "server_unreachable", "server_fence_unavailable", "server_fence_failed", "pointer_unavailable", "device_proof_unavailable", "one_home_unavailable", "key_storage_unavailable", "disk_space", "disk_unknown", "reauth_required", "strong_signin_required", "engines_not_confirmed", "engine_too_old"]);
  const isLocalCauseWait = (w: string | undefined): boolean => !!w && (LOCAL_CAUSE_WAITS.has(w) || (w.startsWith("engine_") && !EXTERNAL_WAITS.has(w)));
  /** Desktop repair 6: waits whose cause IS this computer although `isLocalCauseWait` (the signal-driven wake) does not list them: this computer's own staging, its own key, the finish of its own derived files. Only `waitKindOf` reads it. */
  const LOCAL_KIND_WAITS = new Set(["memory_finish_left", "conversation_no_chat", "words_not_linked", "import_remaining_limit", "import_refused", "staging_missing", "home_key_missing", "purge_refused", "native_table_failed"]);
  /** `unknown` (desktop repair 6): a code no table above knows says nothing about the cause - it used to be told as `local` ("this computer"), which a screen then worded as fact. The three older values keep their meaning. */
  const waitKindOf = (w: string | undefined): "designed" | "external" | "local" | "unknown" | null => !w ? null : DESIGNED_WAITS.has(w) ? "designed" : EXTERNAL_WAITS.has(w) || w.startsWith("engine_deferred_") ? "external" : isLocalCauseWait(w) || LOCAL_KIND_WAITS.has(w) ? "local" : "unknown";
  /** True when the recorded move waits for a cause on this computer. */
  function waitingOnLocalCause(): boolean { const s = ctx.account(); const m = s ? ctx.load(s.userId)?.move : undefined; return !!m && (isLocalCauseWait(m.waiting) || m.blocker !== undefined); }
  /**
   * Desktop E2E-1 (D5): the server answered a MOMENT it cannot hold for the move - its own call to the Companion service (the fence) was down (503 `server_fence_unavailable`) or failed (`server_fence_failed`), or it is being updated
   * (`server_update_pending`). Nothing is wrong on this computer and nothing here can end it, but without a deadline the move waited for the next signal (a screen opening, a wake): a move that stopped here sat for minutes. These codes now take the
   * same road `server_update_pending` always had: the SAME call again after 2 s, 4 s, 8 s ... (at most every 5 minutes, `backoffMs`), the one deadline timer aims at `retryAt`. No new timer, no new number, no new column.
   */
  const SERVER_MOMENT_WAITS: ReadonlySet<string> = new Set(["server_update_pending", "server_fence_unavailable", "server_fence_failed"]);
  function waitServerMoment(userId: string, code: string): Outcome {
    const tries = (ctx.load(userId)?.move?.attempts ?? 0) + 1;
    patchMove(userId, { attempts: tries, retryAt: ctx.now() + backoffMs(tries, 2_000) });
    return wait(userId, code);
  }
  const asMs = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
  /**
   * The nearest moment (ms) at which a recorded move ends or turns by itself, or null: the pointer's own end of the request (`move.expiresAt`), the claim's wait, the sender's 30-day purge wait, the receiver's 7 days after the commit.
   * Only a move that exists has one, so a computer with no move has no timer (home.ts aims ONE timer at this, only while a move waits). Past moments are not returned: a deadline that has passed and changed nothing is not aimed at again.
   */
  function nextDeadline(): number | null {
    const s = ctx.account(); if (!s) return null;
    const record = ctx.load(s.userId); const m = record?.move; if (!record || !m) return null;
    const pointer = ctx.pointer(); const pm = pmove(pointer); const found: number[] = [];
    const exp = pm ? asMs(pm.expiresAt) : null;
    if (pm && exp !== null && pm.expired !== true && (!m.moveId || pm.moveId === m.moveId)) found.push(exp);
    if (m.role === "sender" && m.step === "purged" && !m.purgeDone) found.push((m.purgeWaitSince ?? m.startedAt) + PURGE_WAIT_MAX_MS);
    if (m.role === "receiver" && ((m.from === "desktop" && m.step === "imported") || (m.from === "server" && m.step === "caughtUp"))) found.push(importEndsAt(m));   // audit D6: the server-start `caughtUp` has the same end
    if (m.role === "receiver" && m.from === "server" && m.step === "claimed" && pointer && record.pub) {
      const mature = asMs(pointer.claims.find((c) => c.kind === "receive" && rec(c.to)?.pub === record.pub)?.matureAt);
      if (mature !== null) found.push(mature);
    }
    if (typeof m.retryAt === "number") found.push(m.retryAt);
    if (typeof m.signinWait?.matureAt === "number") found.push(m.signinWait.matureAt);
    const now = ctx.now(); const future = found.filter((t) => t > now);
    return future.length ? Math.min(...future) : null;
  }

  /**
   * (contract home-move-phone-card §7 R8): is this computer waiting for a person on ANOTHER device to answer its request, and until when. Only then does home.ts read the pointer without a signal (home-response-wait.ts).
   * All of: receiver of a move from a computer; the step `fetched` waiting with `waiting_sender` (the old computer's window or the phone has not answered / has not put the bundle yet) or `waiting_redeposit` (the old computer is to put it again);
   * the pointer's request is THIS computer's (same move id, `to.pub` is this key) and neither expired nor past its end; the server's writes are open (with them shut a pass does nothing). A wait whose cause is on this computer, or
   * after the commit, or on the server, is never this: it ends by its own signal.
   */
  const RESPONSE_WAITS: ReadonlySet<string> = new Set(["waiting_sender", "waiting_redeposit"]);
  function awaitingResponse(): { sinceMs: number; expiresAt: number } | null {
    const s = ctx.account(); if (!s) return null;
    const record = ctx.load(s.userId); const m = record?.move;
    if (!record || !m || m.role !== "receiver" || m.from !== "desktop" || m.step !== "fetched" || !m.moveId || !m.waiting || !RESPONSE_WAITS.has(m.waiting)) return null;
    if (!ctx.writesOpen()) return null;
    const pm = pmove(ctx.pointer());
    if (!pm || pm.moveId !== m.moveId || !record.pub || pm.to?.pub !== record.pub || pm.expired === true) return null;
    const exp = asMs(pm.expiresAt); if (exp === null) return null;
    return { sinceMs: m.waitSince ?? m.startedAt, expiresAt: exp };
  }

  // ── the pass ──
  /** One pass of the machine for the signed-in account. Single flight: a signal that arrives during a pass makes one more pass after it. */
  function drive(): Promise<void> {
    if (driving) { if (!shutReading) rerun = true; return driving; }
    driving = (async () => {
      try {
        do { rerun = false; await pass(); } while (rerun);
      } finally { driving = null; try { ctx.passEnded?.(); } catch { /* the timer aim never changes a pass */ } }
    })();
    return driving;
  }

  async function pass(): Promise<void> {
    const cur = current(); if (!cur) return;
    const { userId } = cur;
    syncMirror(cur.record);
    // Audit 62 (home D6): a receiver that has COMMITTED (this computer is the home) has only a local import left - it asks the server nothing, so a closed switch does not hold it; only telling the server (`reported`) waits for the switch.
    const localOnly = (m: MoveRecord | undefined): boolean => !!m && m.role === "receiver" && (m.step === "imported" || m.step === "reported");
    const open = ctx.writesOpen();
    if (!open) { if (await openLocallyIfShut(userId)) return; if (!localOnly(ctx.load(userId)?.move)) return; }   // the server's writes are not open: nothing is signed or sent, the local move waits as it is - except a sealed sender (opens its own door, below) and the local import above
    const move = ctx.load(userId)?.move ?? cur.record.move;
    if (open) sweep(userId, move?.moveId ?? (move ? "pending" : null), move?.stagedDir ?? null, move?.packDir ?? null);
    if (!move) return;
    for (let guard = 0; guard < 24; guard += 1) {
      const now = current(); if (!now || now.userId !== userId) return;       // another account never continues this move
      const m = now.record.move; if (!m) return;
      if (!ctx.writesOpen() && !localOnly(m)) return;
      const outcome = await handleStep(now, m);
      if (outcome === "again") continue;
      return;
    }
  }

  /**
   * Audit 59 B6. A sender that is `sealed` when the SERVER shuts the writes (the switch closed again - the operator's undo - or the pointer routes answer 404) can never go on: nothing may be signed, and its own personal agent refuses
   * every message (`one_sealed`). It opens itself again, locally only (no server call): the record first, the engine mirror next (opening order), the pack folder, the locked bytes and the secrets go (`closeMove`).
   * Only when ALL hold: the record is a sealed sender before the commit was seen; the server itself showed that it shut (an unreachable server is not that); a fresh pointer read (a GET works with the switch closed) does not name
   * another computer as the home (that would be the committed move: the computer is `away`'s business, never two homes); and the switch did not open again meanwhile. A request that is still on the server is left to its expiry
   * (the owner is asked again when the switch opens: `noteIncoming`). Returns true when it opened.
   */
  async function openLocallyIfShut(userId: string): Promise<boolean> {
    const record = ctx.load(userId); const m = record?.move;
    if (!record || record.state !== "sealed" || m?.role !== "sender" || !(m.step === "sealed" || m.step === "packed" || m.step === "uploaded" || m.step === "left")) return false;
    if (!ctx.serverShut?.()) return false;
    let fresh = false;
    shutReading = true; try { fresh = await ctx.readPointer().catch(() => false); } finally { shutReading = false; }   // one GET: the pointer as the server shows it now (a 404 or a failure keeps what was known: `fresh` is false then)
    if (ctx.writesOpen()) { rerun = true; return false; }       // it opened again: the normal pass runs next
    if (!ctx.serverShut?.()) return false;
    const key = ctx.keyed(userId); const pointer = ctx.pointer();
    if (!key) return false;
    // Audit 61 N-1: a pointer that was NOT read just now (a 404, a failure) is the one this computer knew before: it may be older than a commit (receiver committed, this computer never saw it). Where nothing was sent yet (`sealed`,
    // `packed`: no commit is possible, the receiver commits only bytes that were put) an old pointer is enough. From the put on (`uploaded`, `left`) only a 200 that names THIS computer as the home opens the door: otherwise it stays
    // sealed and waits (the move's folder and keys are kept, so the purge still works when the pointer comes back and says `away`). Never two homes.
    if (!fresh && !pushedNothing(m.step)) return false;
    if (pointer && !(pointer.home.kind === "desktop" && pointer.home.hostId === key.hostId && pointer.pub === key.pub)) return false;   // another computer is the home: committed
    await closeMove(userId, "cancelled", "writes_closed");
    return true;
  }
  /** The steps of a sealed sender in which nothing was put on the server yet. */
  const pushedNothing = (step: MoveStep | undefined): boolean => step === "sealed" || step === "packed";

  type Outcome = "again" | "wait" | "end";
  const wait = (userId: string, code: string): Outcome => {
    const was = ctx.load(userId)?.move;
    patchMove(userId, { waiting: code, ...(was?.waiting === code && was.waitSince !== undefined ? {} : { waitSince: ctx.now() }) });
    return "wait";
  };

  /**
   * (pair test 8, observation 3). The owner confirmed the connected home ("it was me"). A server-start move that committed while the home was unconfirmed stops at `caughtUp` with the wait word `home_unconfirmed`
   * (the mirror's take is refused for exactly that cause) and each refused take pushed its own backoff (`retryAt`, 2 s doubling to 5 minutes) - the confirmation did not end it, so the move (and the first upload that
   * `move_in_progress` holds back until the move ends) waited out the rest of the backoff or the next start. The cause of THAT wait ended with this signal: its backoff goes, and the move is driven now. A move that waits for
   * anything else keeps its backoff and its wait. No timer, no stored column (`retryAt`/`attempts` are the move's own fields).
   */
  async function confirmedHome(userId: string): Promise<void> {
    const m = ctx.load(userId)?.move;
    if (!m || m.waiting !== "home_unconfirmed") return;
    if (m.retryAt !== undefined || (m.attempts ?? 0) > 0) patchMove(userId, { retryAt: undefined, attempts: 0 });
    await drive();
  }

  async function handleStep(cur: NonNullable<ReturnType<typeof current>>, m: MoveRecord): Promise<Outcome> {
    // Audit 62 (pointer §19.3, move §14): a server that named the moment to try again (`server_storage_full`, a window 429: `retryAfterSeconds`) is not knocked before it - the signals that arrive meanwhile change nothing; the one deadline timer (and any later signal) goes on from there.
    if (m.retryAt !== undefined && ctx.now() < m.retryAt && m.step === "caughtUp") return "wait";
    if (m.retryAt !== undefined && ctx.now() < m.retryAt && (m.waiting === "server_storage_full" || m.waiting === "rate_limited" || m.waiting === "request_timeout" || m.waiting === "server_update_pending" || m.waiting === "server_fence_unavailable" || m.waiting === "server_fence_failed" || m.waiting === "words_not_linked")) return "wait";
    if (m.role === "receiver" && m.from === "server") return receiveFromServer(cur, m);
    if (m.role === "receiver") { const out = await receiveFromDesktop(cur, m); return out === "wait" ? endImportWait(cur.userId, out) : out; }
    return sendFromDesktop(cur, m);
  }
  /**
   * Audit 62 (home D4). A receiver that committed and cannot import waits - with ANY code (engine copy not confirmed, home state denied, refused, remaining limit, native table, stage, key storage, staging missing, step unknown...).
   * Every one of them has the end the server's own `import_pending` has: 7 days after the commit. Past it this computer is the home with what it has imported (the counts), the old home still holds every line (it purges only after
   * `importedAt`), and its records come by the old-record road (the old home is a computer this one has seen: `seenHomes` was written at the commit). The code it was waiting with is kept (`waitedFor`).
   */
  /** The moment the receiver's wait for the import ends: the server's own `last.importDeadline` when it shows it for THIS move (web `a9bc9a0e`), else 7 days after the commit as this computer wrote it down. */
  function importEndsAt(m: MoveRecord): number {
    const last = plast(ctx.pointer()) as { moveId?: string; importDeadline?: unknown } | null;
    const fromServer = last && m.moveId && last.moveId === m.moveId ? asMs(last.importDeadline) : null;
    return fromServer ?? (m.committedAt ?? commitTimeOf(plast(ctx.pointer()), m)) + REDEPOSIT_WAIT_MAX_MS;
  }
  async function endImportWait(userId: string, out: Outcome): Promise<Outcome> {
    const rec = ctx.load(userId)?.move;
    if (!rec || rec.role !== "receiver" || rec.step !== "imported") return out;
    if (importEndsAt(rec) > ctx.now()) return out;
    const waited = rec.waiting ?? "unknown";
    if (waited === "waiting_redeposit") return out;   // its own end (`redeposit_expired`) is in the step
    await closeMove(userId, "stopped", "import_expired", { notImported: 1, leftOnOldHome: 1, imported: Number(rec.counts?.messagesInserted ?? 0) }, waited);
    return "end";
  }

  // ── receiver, from the server (§3.3 first table) ──
  async function receiveFromServer(cur: NonNullable<ReturnType<typeof current>>, m: MoveRecord): Promise<Outcome> {
    const { userId, session, key } = cur;
    const pointer0 = ctx.pointer();
    if (!pointer0 && m.step !== "imported") return wait(userId, "pointer_unavailable");
    const pointer = pointer0 as PointerLike;   // null only at `imported` (D6: the local import reads no pointer)
    const mine = !!pointer0 && pointer.home.kind === "desktop" && pointer.home.hostId === key.hostId && pointer.pub === key.pub;
    // The pointer already names this computer (killed after the commit): the commit is done, go on from there.
    if (mine && (m.step === "claimed" || m.step === "requested" || m.step === "sealed" || m.step === "fetched" || m.step === "checked")) { setStep(userId, "committed"); return "again"; }
    const pm = pmove(pointer);
    switch (m.step) {
      case "claimed": {
        // The request is already on the server and is this computer's (the claim was used up by `move/start`, then the app was killed): go on with it.
        // Audit 62 (web `a9bc9a0e`, pointer §19.2): an EXPIRED request that names this computer is a ticket, not a live move: inside `move.resumeUntil` this computer starts again with `move/start` - no new claim, no 7-day wait.
        if (pm?.moveId && pm.to?.pub === key.pub && pm.expired === true) {
          const until = asMs((pm as { resumeUntil?: unknown }).resumeUntil);
          if (until !== null && until > ctx.now()) { setStep(userId, "requested"); return "again"; }
        }
        if (pm?.moveId && pm.to?.pub === key.pub && pm.expired !== true) { setStep(userId, "fetched", { moveId: pm.moveId }); return "again"; }
        const claim = pointer.claims.find((c) => c.kind === "receive" && rec(c.to)?.pub === key.pub);
        if (!claim) {
          const out = await ctx.call("claim/receive", "host", { expectEpoch: pointer.epoch, pub: key.pub, ...labelField() }, session, key);
          if (!out.ok) return failCall(userId, out, () => startRetry(userId));
          crash("receiver:claimed:after-claim");
          return "again";
        }
        // Audit 62: a `receive` claim is usable at once (`usableFrom`/`matureAt` are "now"); a value that is not yet reached - an older server - still waits, with its end on the state (`nextDeadlineAt`). No branch needs a constant.
        const usableAt = asMs(claim.usableFrom) ?? asMs(claim.matureAt);
        const matured = usableAt !== null && usableAt <= ctx.now();
        if (claim.approved !== true && !matured) return wait(userId, "waiting_approval");
        setStep(userId, "requested"); return "again";
      }
      case "requested": {
        const out = await ctx.call("move/start", "host", { expectEpoch: pointer.epoch, pub: key.pub, ...labelField() }, session, key);
        if (!out.ok) {
          if (out.code === "approval_required") { setStep(userId, "claimed"); return wait(userId, "waiting_approval"); }
          if (out.code === "stale_epoch") { await ctx.readPointer(); return wait(userId, "stale_epoch"); }
          return failCall(userId, out, () => startRetry(userId));
        }
        const moveId = pmove(ctx.pointer())?.moveId;
        if (!moveId) return wait(userId, "move_missing");
        crash("receiver:requested:after-start");
        setStep(userId, "fetched", { moveId }); return "again";   // TH: the server is not sealed any more (the server keeps answering): the read starts at once
      }
      case "sealed": {
        // TH (contracts/one-home-move.md 16.1): `move/sealed` is not called. A record written by an older build that stopped at this step goes on to the read; the server's step needs no write from here.
        setStep(userId, "fetched"); return "again";
      }
      case "fetched": return fetchExport(cur, m);
      case "checked": {
        const dir = exportDirOf(dirsOf(userId).stagingBase, m.moveId!);
        const msgs = planServerMessages(readSection(dir, "messages"));
        const facts = planServerFacts(readSection(dir, "facts"));
        setStep(userId, "committed", { counts: { messages: msgs.lines.length, photoOnlySkipped: msgs.photoOnlySkipped, facts: facts.writes.length, factsSkipped: facts.skipped, droppedScheduledCheckins: readSection(dir, "checkins").length } });
        return "again";
      }
      case "committed": {
        if (!mine) {
          const out = await ctx.call("move/commit", "host", { moveId: m.moveId, expectEpoch: pointer.epoch }, session, key);
          if (!out.ok) {
            if (out.code === "no_such_move") { const again = ctx.pointer(); if (!(again?.home.kind === "desktop" && again.home.hostId === key.hostId)) return endedOrWait(userId, out); }
            else return endedOrWait(userId, out);
          }
        }
        crash("receiver:committed:after-commit");
        const after = ctx.pointer();
        if (!(after && after.home.kind === "desktop" && after.home.hostId === key.hostId)) return wait(userId, "commit_not_seen");
        // One write of the local record (home + epoch + next step), then the mirror.
        const record = ctx.load(userId)!;
        ctx.save(userId, { ...record, state: "home", epoch: after.epoch, move: { ...record.move!, step: "imported", waiting: undefined, attempts: 0, committedAt: ctx.now() } });
        crash("receiver:committed:after-record");
        ctx.deps.setMirror("home");
        return "again";
      }
      case "imported": return importServerCopy(cur, m);
      case "caughtUp": {
        // TH (one-home-move.md 16.1, F4): "one more take" = the ordinary take of the mirror - `messages` with NO cursor (from the server's own acknowledgement mark, stopping at a number still being written), never from the last number of the
        // read before the commit. What the server took meanwhile (the phone's words, memory lines, forgets) comes now, before the first upload. Every id is idempotent: killed here, the take simply runs again.
        // Audit D6: a wait that never ends is a defect of ours. `caughtUp` is "one more take" - everything was already imported - so past the same end as every other wait after the commit (`importEndsAt`: the server's own deadline, else 7 days after the commit)
        // the move is closed as done: the ordinary mirror takes over, and the ordinary upload that `move_in_progress` held back runs (the move's end is a signal: `afterDone`). The word `caught_up_expired` stays on the closed move for a screen.
        if (importEndsAt(m) <= ctx.now()) { setStep(userId, "reported", { caughtUpEnded: m.waiting ?? "caught_up_unfinished" }); return "again"; }
        crash("receiver:caughtUp:before-take");
        const done = ctx.deps.catchUp ? await ctx.deps.catchUp() : { ok: true };
        crash("receiver:caughtUp:after-take");
        if (!done.ok) {
          // asked again by itself: 2 s, 4 s, 8 s ... at most every 5 minutes (`backoffMs`, the one deadline timer aims at `retryAt`); nothing here is lost, the take is idempotent
          const tries = (m.attempts ?? 0) + 1; patchMove(userId, { attempts: tries, retryAt: ctx.now() + backoffMs(tries, 2_000) });
          return wait(userId, done.code && /^[a-z0-9_]{1,48}$/.test(done.code) ? done.code : "server_unreachable");
        }
        setStep(userId, "reported"); return "again";
      }
      case "reported": {
        const out = await ctx.call("move/imported", "host", { moveId: m.moveId }, session, key);
        if (!out.ok) {
          if (out.code === "no_such_move" || out.code === "wrong_phase") { /* already reported or ended on the server: finish locally */ }
          else return failCall(userId, out, undefined);
        }
        crash("receiver:reported:after-imported");
        await closeMove(userId, "done", m.caughtUpEnded ? "caught_up_expired" : undefined, undefined, m.caughtUpEnded);
        try { ctx.deps.afterDone?.(); } catch { /* the first upload also runs at the next signal */ }
        return "end";
      }
      default: return wait(userId, "step_unknown");
    }
  }

  const labelField = (): { label?: string } => { const l = ctx.computerLabel(); return l ? { label: l } : {}; };
  const startRetry = (userId: string) => async (): Promise<{ ok: boolean; code?: string }> => { void userId; await drive(); return { ok: true }; };

  /** A call that did not succeed. A held action (reauth) is remembered; the others are a code on the move. */
  function failCall(userId: string, out: Extract<CallOut, { ok: false }>, retry: (() => () => Promise<{ ok: boolean; code?: string }>) | undefined): Outcome {
    if (out.code === "reauth_required" && retry) { lastActionId = ctx.holdForReauth(userId, retry()); return wait(userId, "reauth_required"); }
    // Audit 62 (web `a9bc9a0e`, pointer §19.3): a 429 says WHAT limit it is. `window`: go again after `retryAfterSeconds` (the moment is on the move and is the next deadline). `count` (`retryable: false`): waiting does not end it - before the commit
    // the move ends with its code (the home opens again); after the commit it waits as before (the other computer's bytes must not be lost).
    const sw = out.body ? readWait((out.body as Record<string, unknown>).wait) : undefined;
    if (sw && sw.reason === "strong_signin_required") {
      const at = asMs(sw.matureAt);
      patchMove(userId, { signinWait: { methods: sw.signinMethods, ...(at !== null ? { matureAt: at } : {}) } });
      return wait(userId, "strong_signin_required");
    }
    if (out.code === "rate_limited" && out.body) {
      const limit = out.body.limit; const rec0 = ctx.load(userId)?.move;
      if (limit === "count" && out.body.retryable === false && rec0 && !["imported", "reported", "purged", "left"].includes(rec0.step)) { void closeMove(userId, "stopped", "rate_limited_count"); return "end"; }
      const secs = typeof out.body.retryAfterSeconds === "number" && Number.isFinite(out.body.retryAfterSeconds) ? Math.min(Math.max(0, out.body.retryAfterSeconds), 3_600) : null;
      if (limit === "window" && secs !== null) { patchMove(userId, { retryAt: ctx.now() + secs * 1_000 }); return wait(userId, "rate_limited"); }
    }
    return SERVER_MOMENT_WAITS.has(out.code) ? waitServerMoment(userId, out.code) : wait(userId, out.unreachable ? "server_unreachable" : out.code);
  }
  /** `no_such_move`, `move_expired`: the request is gone; the local move ends and the plaintext goes. Anything else waits. */
  function endedOrWait(userId: string, out: Extract<CallOut, { ok: false }>): Outcome {
    if (out.code === "no_such_move" || out.code === "move_expired") { void closeMove(userId, out.code === "move_expired" ? "expired" : "replaced", out.code); return "end"; }
    // Audit 62 (pointer §19.4): `fence_refused` (409; `fence_conflict` | `move_released` | `account_gone`) is a refusal waiting cannot change: the move ends with its code. `server_fence_failed` (503) is a moment and waits as before.
    if (out.code === "fence_refused") { void closeMove(userId, "stopped", "fence_refused"); return "end"; }
    return SERVER_MOMENT_WAITS.has(out.code) ? waitServerMoment(userId, out.code) : wait(userId, out.unreachable ? "server_unreachable" : out.code);
  }

  /**
   * Audit 62 / the locked bundle is written to a file while it arrives (its sha-256 counted), size and hash are checked against what the signed pointer showed BEFORE anything is read into memory, and only then is the file read once. `want` absent
   * = no check here (the caller has none). `mismatch` = the bytes are not the announced ones (the file is removed).
   */
  async function downloadBundle(userId: string, cur: NonNullable<ReturnType<typeof current>>, moveId: string, want: { bytes: number; sha: string } | null): Promise<{ ok: true; bytes: Buffer } | { ok: true; file: string } | { ok: false; code: string; unreachable?: boolean; mismatch?: boolean }> {
    const folder = moveFolderOf(dirsOf(userId).stagingBase, moveId);
    try { fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); } catch { /* the call below fails and says so */ }
    const dest = path.join(folder, "bundle.part");
    const got = await ctx.getBundle(cur.session, cur.key, moveId, BUNDLE_WIRE_MAX, dest);
    if (!got.ok) return got;
    if (!("file" in got)) return want && (got.bytes.length !== want.bytes || createHash("sha256").update(got.bytes).digest("hex") !== want.sha) ? { ok: false, code: "bundle_hash_mismatch", mismatch: true } : { ok: true, bytes: got.bytes };
    if (want && (got.size !== want.bytes || got.sha256 !== want.sha)) { removePartial(dest); return { ok: false, code: "bundle_hash_mismatch", mismatch: true }; }
    return { ok: true, file: dest };   // opened from the file (openBundleFile): the locked bytes are never read into memory beside the plaintext; openIntoStaging removes the file
  }

  async function fetchExport(cur: NonNullable<ReturnType<typeof current>>, m: MoveRecord): Promise<Outcome> {
    const { userId, session, key } = cur;
    const dir = exportDirOf(dirsOf(userId).stagingBase, m.moveId!);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const section of EXPORT_SECTIONS) {
      if (sectionDone(dir, section)) continue;
      resetSection(dir, section);
      let cursor: string | null = null; let page = 0;
      for (;;) {
        if (page >= MAX_PAGES) return wait(userId, "export_too_long");
        let out: CallOut | null = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          out = await ctx.call("move/export", "host", { moveId: m.moveId, section, ...(cursor ? { cursor } : {}), limit: 100 }, session, key);
          if (out.ok || !(out.retryable === true || out.code === "busy" || out.code === "server_fence_failed" || out.code === "server_fence_unavailable")) break;
          await pause();
        }
        if (!out || !out.ok) {
          // TH-web 2 (one-home-desktop.md 13.21 item 4): `server_update_pending` = the server is being updated; nobody has anything to do, it ends by itself. The same call is asked again after 2 s, 4 s, 8 s ... (at most every 5 minutes - the rule of
          // `backoffMs`, the one deadline timer aims at it); the move's `waiting` + `waitSince` are the one fact a person may be told ("the server is being updated, waiting since ...").
          if (out && out.code === "server_update_pending") { const tries = (m.attempts ?? 0) + 1; patchMove(userId, { attempts: tries, retryAt: ctx.now() + backoffMs(tries, 2_000) }); return wait(userId, "server_update_pending"); }
          return endedOrWait(userId, out ?? { ok: false, code: "export_failed" });
        }
        const items = out.body.items;
        if (!Array.isArray(items) || out.body.section !== section) return wait(userId, "export_invalid");
        writeExportPage(dir, section, page, items); page += 1;
        const next = out.body.next;
        crash(`receiver:fetched:page:${section}`);
        if (next === null || next === undefined) { markSectionDone(dir, section); break; }
        if (typeof next !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(next) || next === cursor) return wait(userId, "export_invalid");
        cursor = next;
      }
    }
    setStep(userId, "checked"); return "again";
  }

  async function importServerCopy(cur: NonNullable<ReturnType<typeof current>>, m: MoveRecord): Promise<Outcome> {
    const { userId } = cur;
    const dir = exportDirOf(dirsOf(userId).stagingBase, m.moveId!);
    if (!EXPORT_SECTIONS.every((s) => sectionDone(dir, s))) { setStep(userId, "fetched"); return "again"; }   // the plaintext is gone or half: fetch again (the server's copy is still there)
    const d = ctx.deps;
    const result = applyServerExport(dir, m.moveId!, { db: d.bundleHost(userId).db, oneId: d.bundleHost(userId).oneId, ensurePersonalChat: () => d.ensurePersonalChat(), plantContextSeed: (id, t) => d.plantContextSeed(id, t), writeFact: (f) => d.writeFact(f), localProfile: () => d.localProfile(), applyProfile: (p) => d.applyProfile(p), ...(d.noteTurns ? { noteTurns: (pairs) => d.noteTurns!(pairs) } : {}) });
    if (result.state === "partial") {
      // audit D2: words stored but not linked to their turn: asked again by itself (2 s, 4 s ... 5 minutes), never given up and never reported as imported
      if (result.code === "words_not_linked") { const tries = (m.attempts ?? 0) + 1; patchMove(userId, { attempts: tries, retryAt: ctx.now() + backoffMs(tries, 2_000) }); }
      return wait(userId, result.code ?? "import_partial");
    }
    crash("receiver:imported:after-apply");
    const counts = { ...(m.counts ?? {}), wordsMerged: result.messages.merged, wordsDropped: result.messages.dropped, inserted: result.messages.inserted, alreadyThere: result.messages.alreadyThere, elsewhere: result.messages.elsewhere, photoOnlySkipped: result.messages.photoOnlySkipped,
      factsWritten: result.facts.written, factsRejected: result.facts.rejected, factsSkipped: result.facts.skipped, droppedScheduledCheckins: result.checkins.droppedScheduled, profileApplied: result.profile.applied.length, seedPlanted: result.seedPlanted ? 1 : 0 };
    if (result.profile.ask) profileAsk.set(userId, result.profile.ask);
    setStep(userId, "caughtUp", { counts }); return "again";
  }
  /** The one pending profile question (memory only: a restart before the answer simply keeps this computer's value, which is what closing the question does). */
  const profileAsk = new Map<string, NonNullable<ProfilePlan["ask"]>>();


  // ── receiver, from another computer (§3.3 second table) ──
  const pendingBox = "pending";
  async function receiveFromDesktop(cur: NonNullable<ReturnType<typeof current>>, m: MoveRecord): Promise<Outcome> {
    const { userId, session, key } = cur;
    const pointer0 = ctx.pointer();
    if (!pointer0 && m.step !== "imported") return wait(userId, "pointer_unavailable");
    const pointer = pointer0 as PointerLike;   // null only at `imported` (D6: the local import reads no pointer field; the helpers below take null)
    const mine = !!pointer0 && pointer.home.kind === "desktop" && pointer.home.hostId === key.hostId && pointer.pub === key.pub;
    const pm = pmove(pointer); const last = plast(pointer);
    const secrets = ctx.deps.secrets;
    // Killed after the commit: the pointer names this computer and its last move is ours.
    if (mine && m.moveId && last?.moveId === m.moveId && (m.step === "requested" || m.step === "fetched" || m.step === "checked")) { setStep(userId, "committed"); return "again"; }
    // Audit 59 B5: the home this move comes from turned `unconfirmed` while the move runs (a claim that only waited took effect): the move stops, nothing of it is trusted. After the commit this computer IS the home: not this check.
    if (!mine && m.moveId && (m.step === "fetched" || m.step === "checked" || m.step === "committed") && pointer?.homeTrust === "unconfirmed") return stopCancel(cur, "home_unconfirmed");
    switch (m.step) {
      case "requested": {
        // Audit 59 B5: a home that only waited its way in (`unconfirmed`) is not moved from: the owner confirms or reverts it first (the server says the same: 409 `home_unconfirmed`). Nothing is sent, no key made.
        if (pointer.homeTrust === "unconfirmed") return wait(userId, "home_unconfirmed");
        // Audit 59 F-1: the key this computer wrote down for that home is not the key the pointer shows now (a re-key, a lost key file): waiting for the owner's answer BEFORE the sending home seals, packs and uploads for nothing.
        const homeNow = pointer.home.kind === "desktop" ? pointer.home : null;
        const wroteDown = homeNow ? (cur.record.seenHomes ?? []).find((h) => h.hostId === homeNow.hostId) : undefined;
        if (wroteDown && pointer.pub && wroteDown.pub !== pointer.pub) return wait(userId, "home_key_changed");
        let seed = secrets.read(userId, pendingBox, "box");
        if (!seed) { seed = generateBoxKeyPair().secret; if (!secrets.write(userId, pendingBox, "box", seed)) return wait(userId, "key_storage_unavailable"); }
        const boxPub = boxPubFromSeed(seed);
        const boxSig = signBoxPub(key.privateKey, userId, key.hostId, boxPub);
        const senderPub = pointer.pub;
        if (!senderPub) return wait(userId, "home_key_missing");
        // Repair 5 / web E-3: this computer says how big a bundle its engine can take; the sending computer packs under it (`move.to.limitBytes`). A web that does not know the field answers `400 invalid_request` for it: the same call without it,
        // once, and the field is left out for the rest of this run (the sender then reads "no limit" as the legacy 8 MiB - never a bundle this computer cannot take).
        const declared = m.receiverLimit ?? ((await readyOne(ctx.deps.caller(), ctx.deps.engineRoots())).engine100 === true ? BUNDLE_LIMIT_BYTES : BUNDLE_LEGACY_LIMIT_BYTES);
        const startFields = { expectEpoch: pointer.epoch, pub: key.pub, boxPub, boxSig, ...labelField() };
        let out = await ctx.call("move/start", "host", { ...startFields, ...(serverTakesLimit ? { receiverLimitBytes: declared } : {}) }, session, key);
        if (!out.ok && out.code === "invalid_request" && serverTakesLimit) { serverTakesLimit = false; out = await ctx.call("move/start", "host", startFields, session, key); }
        if (!out.ok) {
          if (out.code === "box_mismatch") {
            // The box key was lost or replaced: this request cannot be continued. Cancel it and start a new one with a new key.
            const stale = pmove(ctx.pointer());
            if (stale?.moveId && stale.to?.pub === key.pub) await ctx.call("move/cancel", "host", { moveId: stale.moveId }, session, key);
            secrets.remove(userId, pendingBox, "box");
            await closeMove(userId, "stopped", "box_mismatch"); return "end";
          }
          if (out.code === "stale_epoch") { await ctx.readPointer(); return wait(userId, "stale_epoch"); }
          return failCall(userId, out, () => startRetry(userId));
        }
        const moveId = pmove(ctx.pointer())?.moveId;
        if (!moveId) return wait(userId, "move_missing");
        // The key under the move's own name first, the record next, the temporary name last: a kill between any two of them finds the same key again (the pending file is what a repeated `move/start` is made from).
        if (!secrets.write(userId, moveId, "box", seed)) return wait(userId, "key_storage_unavailable");
        crash("receiver-d:requested:after-start");
        setStep(userId, "fetched", { moveId, senderPub, boxPub, receiverLimit: declared, ...(pointer.home.kind === "desktop" ? { fromHostId: pointer.home.hostId } : {}) });
        secrets.remove(userId, pendingBox, "box");
        return "again";
      }
      case "fetched": {
        if (!pm || pm.moveId !== m.moveId || pm.to?.pub !== key.pub) { await closeMove(userId, pm ? "replaced" : "cancelled", pm ? "request_changed" : "request_gone"); return "end"; }   // a request that is simply GONE (refused, cancelled) says so; "changed" is another request in its place
        if (pm.expired === true) { await closeMove(userId, "expired", "move_expired"); return "end"; }
        if (pm.phase !== "uploaded") return wait(userId, "waiting_sender");
        if (typeof pm.bytes !== "number" || pm.bytes < 1 || pm.bytes > BUNDLE_WIRE_MAX || typeof pm.sha256 !== "string") return stopCancel(cur, "bundle_size_invalid");
        // Security follow-up S1 (contract §2.7): WHO made the bundle is checked before anything is downloaded, with the key this computer trusts (its own record of that computer first, then the key it wrote down at `move/start`).
        const seenFrom = m.fromHostId ? (cur.record.seenHomes ?? []).find((h) => h.hostId === m.fromHostId) : undefined;
        const homePub = seenFrom?.pub ?? m.senderPub;
        if (!homePub || !PUB43.test(homePub) || (seenFrom && m.senderPub && m.senderPub !== seenFrom.pub) || pm.senderPub !== homePub) return stopCancel(cur, "sender_changed");
        const proofCode = checkUploadProof(userId, pm, homePub, m.fromHostId);
        if (proofCode) return wait(userId, proofCode);     // a signal later it is read again (the server may add it; a sender may upload again): never `invalid`, nothing downloaded, nothing written
        const got = await downloadBundle(userId, cur, m.moveId!, { bytes: pm.bytes, sha: pm.sha256 });
        // Audit 59 B11: the held bundle is gone (24-hour expiry, the fetches used up): never an end. The sending home may put the same bytes again (its pass does, `maybeRedeposit`); the next signal reads them then.
        if (!got.ok) { if (got.mismatch) return stopCancel(cur, "bundle_hash_mismatch"); return wait(userId, got.unreachable ? "server_unreachable" : got.code === "bundle_missing" ? "waiting_redeposit" : got.code); }   // a mismatch is dropped before it is opened
        const staged = await openIntoStaging(cur, m, "file" in got ? { file: got.file } : got.bytes, false);
        if ("out" in staged) return staged.out;
        setStep(userId, "checked", { stagedDir: staged.dir, bundleSha: pm.sha256, bundleBytes: pm.bytes }); return "again";
      }
      case "checked": {
        if (!m.stagedDir || !fs.existsSync(m.stagedDir)) { setStep(userId, "fetched"); return "again"; }
        // Repair 5: a wait at this step (an engine that is not ready) used to learn NOTHING about the request: the old home cancelled it, or it expired, and the receiver waited for ever. The same two looks as `fetched`.
        if (!pm || pm.moveId !== m.moveId || pm.to?.pub !== key.pub) { await closeMove(userId, pm ? "replaced" : "cancelled", pm ? "request_changed" : "request_gone"); return "end"; }   // a request that is simply GONE (refused, cancelled) says so; "changed" is another request in its place
        if (pm.expired === true) { await closeMove(userId, "expired", "move_expired"); return "end"; }
        // This computer is the receiver and the engine is called from its own engine home: only here does `wouldStoreFull` (the room this home's Personal store has) mean anything (desktop C item 1).
        // Audit 62 (engine `ready` / `check --engine`): BEFORE the commit the engine says whether this computer can take the import. Not ready = NO commit (the old home stays the home), the blocker is on the state, and the next signal asks again
        // (the owner updating a plugin is not a signal, the next one is); the request's own expiry is the end. An engine from before `ready` goes on as before.
        const roots = ctx.deps.engineRoots();
        const rdy = await readyOne(ctx.deps.caller(), roots, { needBytes: m.bundleBytes });   // the room the import needs: the size of the bundle that was received
        if (rdy.state === "not_ready") {
          const first = rdy.blockers[0];
          // `store_busy` (retryable): asked again with a doubling wait (the one deadline timer aims at it; a signal that the engine's cause ended asks at once). `disk_space_short`: the old home stays the home, the numbers are on the move.
          if (first.retryable) { const tries = (m.attempts ?? 0) + 1; patchMove(userId, { blocker: first, attempts: tries, retryAt: ctx.now() + backoffMs(tries, 2_000) }); return wait(userId, first.reason); }
          patchMove(userId, { blocker: first, ...(first.freeBytes !== undefined || first.needBytes !== undefined ? { counts: { ...(m.counts ?? {}), ...(first.freeBytes !== undefined ? { freeBytes: first.freeBytes } : {}), ...(first.needBytes !== undefined ? { needBytes: first.needBytes } : {}) } } : {}) });
          return wait(userId, first.reason);
        }
        const check = await checkStaged(m.stagedDir, { caller: ctx.deps.caller(), receiving: true, ...(rdy.state === "ready" ? { engineRoots: roots } : {}), ...(rdy.engine100 ? { limitBytes: m.receiverLimit ?? BUNDLE_LIMIT_BYTES } : {}) });
        if (check.state !== "ok") {
          // Repair 5 (engine `limit_in_answer`): `too_large` says what this engine can take. A strictly smaller size than the one this move declared is asked for by starting the move again under it (the sending computer packs under `move.to.limitBytes`, in part);
          // the same size, or no size, or too many starts: the move ends with the code (nothing is committed).
          if (check.code === "engine_too_large") {
            const asked = check.tooLarge?.limitBytes; const declaredNow = m.receiverLimit ?? (rdy.engine100 ? BUNDLE_LIMIT_BYTES : BUNDLE_LEGACY_LIMIT_BYTES);
            if (asked !== undefined && asked >= MIN_LIMIT_BYTES && asked < declaredNow && (m.repacked ?? 0) < MAX_REPACKS) return restartSmaller(cur, m, asked);
          }
          return stopCancel(cur, check.code ?? "bundle_invalid");
        }
        if (check.wouldRefuse === "engines_not_confirmed") { patchMove(userId, { blocker: { reason: "engines_not_confirmed", needs: "plugin_update" } }); return wait(userId, "engines_not_confirmed"); }
        const would = check.wouldBlank ?? 0;
        // A number from an earlier check that this one did not give is not kept: absent = not known, never 0 and never the old value.
        const { wouldStoreFull: _staleRoom, ...earlier } = (m.counts ?? {}) as Record<string, number>;
        if (would > BLANK_CONFIRM_ABOVE && m.confirmBlank !== would) { patchMove(userId, { blankAsk: { count: would }, confirmBlank: undefined, counts: { ...earlier, wouldBlank: would } }); return wait(userId, "waiting_blank_confirm"); }
        setStep(userId, "committed", { blocker: undefined, engine100: rdy.engine100 === true, blankAsk: undefined, counts: { ...earlier, ...(check.counts ?? {}), wouldBlank: would, ...(typeof check.rejected === "number" ? { rejectedPreview: check.rejected } : {}),
          // Engine 11-12 (`check` answer `wouldStoreFull`: an upper estimate of the lines the receiving Personal store has no room for; they stay on the old home): a number for the screen, from the receiver's own check only.
          ...(typeof check.wouldStoreFull === "number" ? { wouldStoreFull: check.wouldStoreFull } : {}) } });
        return "again";
      }
      case "committed": {
        if (!mine) {
          patchMove(userId, { fromConfirmed: true });          // B5: written BEFORE the commit is sent (the home was `confirmed`: the check at the top of this function); `seenHomes` takes the sender only with this
          const out = await ctx.call("move/commit", "host", { moveId: m.moveId, expectEpoch: pointer.epoch }, session, key);
          if (!out.ok) {
            const again = ctx.pointer();
            if (!(out.code === "no_such_move" && again?.home.kind === "desktop" && again.home.hostId === key.hostId)) return endedOrWait(userId, out);
          }
        }
        crash("receiver-d:committed:after-commit");
        const after = ctx.pointer();
        if (!(after && after.home.kind === "desktop" && after.home.hostId === key.hostId)) return wait(userId, "commit_not_seen");
        const record = ctx.load(userId)!;
        // The computer this home came from is one this computer has now seen (its key as the move pinned it): its old records are merged without a question.
        const from = record.move?.fromHostId && record.move.senderPub && record.move.fromConfirmed === true ? { hostId: record.move.fromHostId, pub: record.move.senderPub } : null;
        const seen = from ? [...(record.seenHomes ?? []).filter((h) => h.hostId !== from.hostId), from].slice(-8) : record.seenHomes;
        ctx.save(userId, { ...record, state: "home", epoch: after.epoch, ...(seen ? { seenHomes: seen } : {}), move: { ...record.move!, step: "imported", waiting: undefined, attempts: 0, committedAt: ctx.now() } });
        crash("receiver-d:committed:after-record");
        ctx.deps.setMirror("home");
        return "again";
      }
      case "imported": {
        if (!m.stagedDir || !fs.existsSync(m.stagedDir)) {
          // Audit 59 B11: the staged folder is gone after the commit (swept, restored from a backup): the locked bundle is fetched AGAIN (the server keeps it until `imported`, the old home may put it again) and checked against the
          // size and sha-256 the signed pointer showed before the commit. Without those (a move recorded by an older build) nothing can be checked: the old wait.
          if (!m.bundleSha || !m.bundleBytes || !SHA_RE.test(m.bundleSha)) return wait(userId, "staging_missing");
          const again = await downloadBundle(userId, cur, m.moveId!, { bytes: m.bundleBytes, sha: m.bundleSha });
          if (!again.ok && again.code === "bundle_missing") {
            // Audit 61 (desktop 4): the wait for the old home to put the bytes again has an end - the server's own: a committed move that is not imported within 7 days no longer holds the other computers back (`import_pending` is lifted).
            // Past it this computer is the home with NOTHING imported and says so (a code and counts, no text): the old home still holds every line (it purges only after `importedAt`), and its records can still come by the old-record road.
            if (importEndsAt(m) <= ctx.now()) { await closeMove(userId, "stopped", "redeposit_expired", { notImported: 1, leftOnOldHome: 1 }); return "end"; }
            return wait(userId, "waiting_redeposit");
          }
          if (!again.ok) return wait(userId, again.unreachable ? "server_unreachable" : again.code);
          const restaged = await openIntoStaging(cur, m, "file" in again ? { file: again.file } : again.bytes, true);
          if ("out" in restaged) return restaged.out;
          setStep(userId, "imported", { stagedDir: restaged.dir }); return "again";
        }
        // Audit 62: an import the engine refused with `retryable: false` is not asked again at every signal (`check` + `import`, eight times in eight signals): the cheap read-only `ready` is. It goes on when the engine says ready (or does not know `ready`).
        if (m.blocker?.held) {
          const again = await readyOne(ctx.deps.caller(), ctx.deps.engineRoots());
          if (again.state === "not_ready") { patchMove(userId, { blocker: { ...again.blockers[0], held: true } }); return wait(userId, again.blockers[0].reason); }
          patchMove(userId, { blocker: undefined });
        }
        const sources = ctx.deps.sources();
        const host = ctx.deps.bundleHost(userId);
        // The import runs on a COPY of the staged folder: `importStaged` deletes what it is given when it ends, and a kill between that and the record would lose what the import handed back
        // (the refused ids the old home must keep, the profile). The original is deleted only after the record has the results. Every part of the import is idempotent, so it simply runs again.
        const work = stageBundle(m.stagedDir, { stagingBase: dirsOf(userId).stagingBase });
        if (work.state !== "staged" || !work.dir) return wait(userId, work.code ?? "stage_failed");
        patchMove(userId, { importingSince: m.importingSince ?? ctx.now() });   // / "importing", since when (cleared with the next step)
        const res = await importStaged(work.dir, host, { caller: ctx.deps.caller(), retryPauseMs: ctx.deps.pauseMs ?? 1000, ...(m.engine100 ? { limitBytes: BUNDLE_LIMIT_BYTES } : {}), ...(m.confirmBlank !== undefined ? { confirmBlank: m.confirmBlank } : {}), engineRoots: ctx.deps.engineRoots() });
        if (res.state !== "imported") discardStaged(work.dir);
        crash("receiver-d:imported:after-import");
        if (res.state === "refused") {
          if (res.code === "blank_over_limit") { patchMove(userId, { blankAsk: { count: Number(res.wouldBlank ?? 0) }, confirmBlank: undefined }); return wait(userId, "waiting_blank_confirm"); }
          if (res.retryable === false && res.needs && res.needs !== "confirm_blank" && res.needs !== "new_bundle" && res.needs !== "smaller_bundle") {
            const rdy = await readyOne(ctx.deps.caller(), ctx.deps.engineRoots());
            const named = rdy.state === "not_ready" ? rdy.blockers.find((b) => b.reason === res.code) : undefined;
            patchMove(userId, { blocker: { reason: String(res.code ?? "import_refused").slice(0, 48), needs: res.needs, ...(named?.hosts ? { hosts: named.hosts } : {}), held: true } });
          }
          if (res.code === "engines_not_confirmed") { patchMove(userId, { counts: { ...(m.counts ?? {}), enginesNotConfirmed: Array.isArray((res.engines as { notConfirmed?: unknown[] } | undefined)?.notConfirmed) ? (res.engines as { notConfirmed: unknown[] }).notConfirmed.length : 1 } }); return wait(userId, "engines_not_confirmed"); }
          return wait(userId, res.code ?? "import_refused");
        }
        if (res.state === "remaining") { const attempts = (m.attempts ?? 0) + 1; patchMove(userId, { attempts }); return wait(userId, attempts >= MAX_ATTEMPTS ? "import_remaining_limit" : (res.code ?? "import_remaining")); }
        if (res.state === "partial") return wait(userId, res.code ?? "import_partial");
        if (res.state === "invalid") { await closeMove(userId, "stopped", res.code ?? "bundle_invalid"); return "end"; }
        const back = applyHandedBack(sources, { profile: res.profile, avatar: res.avatar, settings: res.settings });
        if (back.ask) profileAsk.set(userId, back.ask);
        const krej = ctx.deps.secrets.read(userId, m.moveId!, "krej");
        const mem = (res.memory ?? {}) as Record<string, unknown>;
        const ids = (res.rejectedIds ?? []).slice(0, 200);
        const rejectedCount = res.rejected ?? 0;
        const masked = krej ? ids.map((id) => maskId(krej, id)) : [];
        const counts = { ...(m.counts ?? {}), messagesInserted: res.conversation?.inserted ?? 0, droppedSystem: res.conversation?.droppedSystem ?? 0, noticesStripped: res.conversation?.noticesStripped ?? 0, droppedMessages: res.droppedMessages ?? 0, droppedEmbeddings: res.droppedEmbeddings ? 1 : 0,
          checkinsAdded: res.checkinsAdded ?? 0, rejected: rejectedCount, blanked: Number(mem.blanked ?? 0), blankedOlder: Number(mem.blankedOlder ?? 0), profileApplied: back.applied.length, avatarApplied: back.avatarApplied ? 1 : 0 };
        setStep(userId, "reported", { counts, ...(rejectedCount > 0 ? { rejected: { count: rejectedCount, ids: masked, truncated: res.rejectedIdsTruncated === true || masked.length < rejectedCount } } : {}), confirmBlank: undefined, stagedDir: undefined });
        discardStaged(m.stagedDir);          // the original goes only now, after the record holds the results
        return "again";
      }
      case "reported": {
        const rj = m.rejected;
        // Audit 59 B7: the count is ALWAYS sent, `0` too ("refused nothing" is a statement; no number is "not known" to the sending home, which then deletes nothing).
        const out = await ctx.call("move/imported", "host", { moveId: m.moveId, rejected: rj && rj.count > 0 ? rj.count : 0, ...(rj && rj.count > 0 ? { rejectedIds: rj.ids, ...(rj.truncated ? { rejectedIdsTruncated: true } : {}) } : {}) }, session, key);
        if (!out.ok && out.code !== "no_such_move" && out.code !== "wrong_phase") return failCall(userId, out, undefined);
        crash("receiver-d:reported:after-imported");
        await closeMove(userId, "done"); return "end";
      }
      default: return wait(userId, "step_unknown");
    }
  }

  /**
   * Contract §2.7: the sender's own signature over `move/uploaded` (kept by the server in `move.uploadProof`), checked here with the key this computer trusts. null = verified.
   * Answers (all are "read again at the next signal", none is `invalid`, so a normal retry of the sender is never blocked): `sender_proof_missing` (no proof yet or an older document),
   * `sender_proof_invalid` (shape or signature does not hold). The ts window and the nonce are not looked at (the server did that when the request came; this is read days later).
   */
  function checkUploadProof(userId: string, pm: PointerMoveView, homePub: string, fromHostId: string | undefined): string | null {
    const pr = pm.uploadProof;
    if (!pr || typeof pr !== "object") return "sender_proof_missing";
    const hostId = pm.from?.hostId;
    if (typeof hostId !== "string" || pm.from?.kind !== "desktop" || (fromHostId && hostId !== fromHostId)) return "sender_proof_invalid";
    if (!Number.isSafeInteger(pr.ts) || typeof pr.nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(pr.nonce) || typeof pr.sig !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(pr.sig)) return "sender_proof_invalid";
    if (typeof pm.moveId !== "string" || !Number.isSafeInteger(pm.bytes) || typeof pm.sha256 !== "string" || !SHA_RE.test(pm.sha256) || typeof pm.senderPub !== "string") return "sender_proof_invalid";
    const body = { hostId, ts: pr.ts, nonce: pr.nonce, moveId: pm.moveId, bytes: pm.bytes, sha256: pm.sha256, senderPub: pm.senderPub };
    return ctx.verify(homePub, ctx.signedText("move/uploaded", userId, body), pr.sig) ? null : "sender_proof_invalid";
  }

  /**
   * Contract one-home-move §2.8. The signed text of the new home's `move/imported` rebuilt from the pointer's `last` and `importedProof` (the body is `{ hostId, ts, nonce, moveId }` plus, for every name in `sent`, that field of `last`), checked with the new home's key.
   * `rejectedIds` is the list as it stands now: after 30 days it is gone and a proof that carried a count above 0 cannot be rebuilt - the answer is false and nothing is deleted. `ts` and the nonce are not looked at (the server did that when the request came).
   */
  function importedProofHolds(userId: string, last: ReturnType<typeof plast>, homeKey: string): boolean {
    const pr = last?.importedProof;
    if (!last || !pr || typeof last.moveId !== "string" || !PUB43.test(homeKey)) return false;
    const body: Record<string, unknown> = { hostId: pr.hostId, ts: pr.ts, nonce: pr.nonce, moveId: last.moveId };
    for (const name of pr.sent) {
      if (name === "rejected") { if (typeof last.rejected !== "number") return false; body.rejected = last.rejected; }
      else if (name === "rejectedIds") body.rejectedIds = Array.isArray(last.rejectedIds) ? last.rejectedIds : [];
      else if (name === "rejectedIdsTruncated") body.rejectedIdsTruncated = last.rejectedIdsTruncated === true;
      else return false;
    }
    try { return ctx.verify(homeKey, ctx.signedText("move/imported", userId, body), pr.sig); } catch { return false; }
  }

  /** The bundle (or the request) is unusable before the commit: cancel the request on the server, clean up, end with the code. `invalid` is never asked again. */
  /**
   * Repair 5 (engine `too_large` + `limitBytes`, before the commit): the move is cancelled and started again as a NEW request that declares the smaller size (`receiverLimitBytes`); nothing was committed, the old home is still the home and the plaintext of this one is deleted.
   * Strictly smaller every time (`asked < the declared size`, at most MAX_REPACKS, never below 1 MiB): a chain that cannot end does not start.
   */
  async function restartSmaller(cur: NonNullable<ReturnType<typeof current>>, m: MoveRecord, limit: number): Promise<Outcome> {
    const { userId, session, key } = cur;
    if (m.moveId) await ctx.call("move/cancel", "host", { moveId: m.moveId }, session, key);
    await closeMove(userId, "replaced", "bundle_repack", { repackLimitBytes: limit });
    const record = ctx.load(userId); if (!record || record.move) return "end";
    ctx.save(userId, { ...record, move: { role: "receiver", from: "desktop", step: "requested", startedAt: ctx.now(), receiverLimit: limit, repacked: (m.repacked ?? 0) + 1 } });
    return "again";
  }
  async function stopCancel(cur: NonNullable<ReturnType<typeof current>>, code: string): Promise<Outcome> {
    const m = cur.record.move!;
    if (m.moveId) await ctx.call("move/cancel", "host", { moveId: m.moveId }, cur.session, cur.key);
    await closeMove(cur.userId, "stopped", code); return "end";
  }

  /**
   * The locked bytes are opened with this move's box key and written into a staging folder, then staged (checked) for the import. Before the commit a failure cancels the request (`stopCancel`); after it (the staged
   * folder was lost and the bundle was fetched again) nothing can be cancelled any more: the step waits with the code and is read again at the next signal.
   */
  async function openIntoStaging(cur: NonNullable<ReturnType<typeof current>>, m: MoveRecord, source: Buffer | { file: string }, committed: boolean): Promise<{ dir: string } | { out: Outcome }> {
    const { userId, key } = cur; const secrets = ctx.deps.secrets;
    const fail = async (code: string): Promise<{ out: Outcome }> => ({ out: committed ? wait(userId, code) : await stopCancel(cur, code) });
    const seed = secrets.read(userId, m.moveId!, "box");
    if (!seed || !m.boxPub || !m.senderPub) return fail("box_key_lost");
    const bundleCtx = { moveId: m.moveId!, toPub: key.pub, boxPub: m.boxPub, senderPub: m.senderPub };
    const opened = Buffer.isBuffer(source) ? openBundle(source, seed, bundleCtx) : openBundleFile(source.file, seed, bundleCtx);
    if (!Buffer.isBuffer(source)) removePartial(source.file);   // the downloaded copy goes as soon as it is opened (or refused)
    if ("invalid" in opened) return fail(opened.invalid);   // `invalid` is never asked again
    // The key that masks refused ids is stored BEFORE any plaintext is written: when it cannot be kept, nothing is on disk and the step waits (read again at the next signal).
    if (!secrets.write(userId, m.moveId!, "krej", opened.krej)) return { out: wait(userId, "key_storage_unavailable") };
    crash("receiver-d:fetched:after-open");
    const { stagingBase } = dirsOf(userId);
    const download = path.join(moveFolderOf(stagingBase, m.moveId!), "download");
    fs.rmSync(download, { recursive: true, force: true }); fs.mkdirSync(download, { recursive: true, mode: 0o700 });
    for (const f of opened.files) fs.writeFileSync(path.join(download, f.name), f.bytes, { mode: 0o600 });
    crash("receiver-d:fetched:after-download");
    const staged = stageBundle(download, { stagingBase });
    fs.rmSync(download, { recursive: true, force: true });
    if (staged.state !== "staged" || !staged.dir) return fail(staged.code ?? "stage_failed");
    return { dir: staged.dir };
  }

  // ── sender (§3.3 third table) ──
  /** Records a request of another computer against this living home. Nothing is locked, sealed or sent (`asked`). A request that changed while still `asked` replaces the recorded id. */
  function noteIncoming(userId: string, pointer: PointerLike): void {
    const record = ctx.load(userId); const key = ctx.keyed(userId);
    if (!record || !key || record.state !== "home") return;
    const mine = pointer.home.kind === "desktop" && pointer.home.hostId === key.hostId && pointer.pub === key.pub;
    const pm = pmove(pointer);
    if (!mine || !pm?.moveId || pm.from?.kind !== "desktop" || pm.from.hostId !== key.hostId || pm.to?.pub === key.pub) return;
    const m = record.move;
    if (!m) { ctx.save(userId, { ...record, move: { role: "sender", from: "desktop", step: "asked", startedAt: ctx.now(), moveId: pm.moveId } }); return; }
    if (m.role === "sender" && m.step === "asked" && m.moveId !== pm.moveId) ctx.save(userId, { ...record, move: { ...m, moveId: pm.moveId, waiting: undefined } });
  }

  /** Pinned values must still be what the pointer says (design: the owner pressed [move] for exactly these). */
  function pinnedHolds(m: MoveRecord, pm: PointerMoveView | null): boolean {
    const p = m.pinned;
    return !!p && !!pm && pm.moveId === p.moveId && pm.to?.pub === p.toPub && pm.to?.boxPub === p.boxPub;
  }
  async function sendFromDesktop(cur: NonNullable<ReturnType<typeof current>>, m: MoveRecord): Promise<Outcome> {
    const { userId, session, key } = cur;
    const pointer = ctx.pointer();
    if (!pointer) return wait(userId, "pointer_unavailable");
    const pm = pmove(pointer); const last = plast(pointer);
    const committedToOther = pointer.home.kind === "desktop" && pointer.home.hostId !== key.hostId;
    const fs_ = fs;
    // Killed after the upload: the receiver already committed. The pointer names the pinned computer and key: go on from `left` (the pinned values are what makes this safe, not the step).
    if (m.pinned && (m.step === "sealed" || m.step === "packed" || m.step === "uploaded") && pointer.home.kind === "desktop" && pointer.home.hostId === m.pinned.toHostId && pointer.pub === m.pinned.toPub) { setStep(userId, "left"); return "again"; }
    // A cancelled or expired request: the home opens again and the packed folder goes.
    if (m.step !== "left" && m.step !== "purged" && !committedToOther && (!pm || pm.moveId !== m.moveId) && m.step !== "asked") { await closeMove(userId, pm ? "replaced" : "cancelled", "request_changed"); return "end"; }
    switch (m.step) {
      case "asked": {
        if (!pm || (m.moveId && pm.moveId !== m.moveId)) { if (!pm) { await closeMove(userId, "cancelled", "request_gone"); return "end"; } patchMove(userId, { moveId: pm.moveId }); }
        if (pm?.expired === true) { await closeMove(userId, "expired", "move_expired"); return "end"; }
        if (pm?.approved === true) { const r = approveNow(userId, "phone"); if (!r.ok) return wait(userId, r.code!); return "again"; }
        return wait(userId, "waiting_owner");
      }
      case "approved": {
        if (!pinnedHolds(m, pm)) { patchMove(userId, { pinned: undefined, approvedBy: undefined }); setStep(userId, "asked"); return wait(userId, "request_changed"); }
        // Repair 5: a wait at this step (the engine does not answer, the personal agent is working, the folder has no room) learned nothing about the request: it expired on the server and this record waited with its code for ever. The home is not sealed
        // here (it is sealed only after `measure`), so ending is local and changes nothing else - the same look `asked`, `packed` and `uploaded` have.
        if (pm?.expired === true) { await closeMove(userId, "expired", "move_expired"); return "end"; }
        const rest = ctx.deps.resting();
        if (!rest.ok) { patchMove(userId, { counts: { ...(m.counts ?? {}), activeWork: ctx.deps.activeWorkCount() } }); return wait(userId, rest.why ?? "not_resting"); }
        // Audit 61 desktop 1: BEFORE this computer closes (nothing sealed, the personal agent keeps working) the engine says whether the memory file will fit the bundle. A store that cannot fit ends the request here with its own code and the numbers;
        // an engine without `measure`, or no answer, goes on as before (the pack step unseals at once on `too_large`).
        let outDir: string | undefined;
        try { outDir = dirsOf(userId).workDir; fs.mkdirSync(outDir, { recursive: true, mode: 0o700 }); } catch { outDir = undefined; }
        // Repair 5 / web E-3: the size this move may be: this computer's own (100 MiB), the receiving computer's (`move.to.limitBytes`; no value = an older computer that said nothing = the legacy 8 MiB), and the server's when it refused a bundle in this run.
        const peerCap = typeof pm?.to?.limitBytes === "number" && pm.to.limitBytes >= MIN_LIMIT_BYTES ? pm.to.limitBytes : BUNDLE_LEGACY_LIMIT_BYTES;
        const wanted = Math.max(MIN_LIMIT_BYTES, Math.min(BUNDLE_LIMIT_BYTES, peerCap, serverBundleCap ?? BUNDLE_LIMIT_BYTES));
        const measured = await measureOne(ctx.deps.bundleHost(userId), { caller: ctx.deps.caller(), ...(outDir ? { outDir } : {}), maxBytes: wanted });
        if (measured.state === "too_large") return stopSender(cur, "store_too_large", { rows: measured.rows, estimatedBytes: measured.estimatedBytes, limitBytes: measured.limitBytes });
        // Audit 62 (home D5): the home is closed ONLY when the engine said it can pack: `fits` or `no_store`. No answer, "cannot say yet" (`deferred`, e.g. the owner is not bound) or a measure that could not be asked: nothing is sealed, the personal agent keeps working,
        // the step waits with the code (read again when its cause ends; the request's own expiry is the end). Only an engine that does not know `measure` goes on as before (the pack step unseals at once on `too_large`).
        // Audit 62 / a store that does not fit whole, with an engine that lists `partial_export`, is moved in part (newest lines first); the rest stays on this computer. The numbers are on the state (rows to carry, rows left behind).
        {
          // Audit 62 / what this move packs for. The memory room is given to `export` (and `measure`) whenever the engine knows 100 MiB; for an engine that only has `partial_export` it is given when the store does not fit.
          const eff = measured.effectiveLimit ?? BUNDLE_LEGACY_LIMIT_BYTES;
          let mem: number | undefined = measured.state === "partial" ? measured.limitBytes : undefined;
          if (mem === undefined && measured.engine100) { try { mem = memoryRoomBytes(ctx.deps.bundleHost(userId), eff); } catch { mem = undefined; } }
          patchMove(userId, { bundleLimit: eff, engine100: measured.engine100 === true, memoryLimit: mem });
        }
        if (measured.state === "partial") patchMove(userId, { memoryLimit: measured.limitBytes, counts: { ...(m.counts ?? {}), rows: (measured.rows ?? 0) + (measured.leftRows ?? 0), movedRows: measured.rows ?? 0, leftRows: measured.leftRows ?? 0 } });
        if (measured.state === "no_answer" || measured.state === "unknown") return wait(userId, measured.state === "no_answer" ? "engine_no_answer" : "measure_unavailable");
        if (measured.state === "deferred") return wait(userId, `engine_deferred_${measured.reason ?? "unknown"}`);
        // Audit 62 (engine `measure --out`): the folder the bundle is written to has no room (or cannot be written): nothing is sealed; the owner's to clear (`disk_space` says how many bytes are free and how many are needed).
        if (measured.state === "no_room") { patchMove(userId, { blocker: { reason: measured.reason ?? "disk_space", needs: measured.reason === "out_unwritable" ? "permission" : "disk_space" }, counts: { ...(m.counts ?? {}), ...(measured.outFreeBytes !== undefined ? { outFreeBytes: measured.outFreeBytes } : {}), ...(measured.estimatedBytes !== undefined ? { estimatedBytes: measured.estimatedBytes } : {}) } }); return wait(userId, measured.reason ?? "disk_space"); }
        // Security follow-up (mirror order by direction): CLOSING writes the engine mirror FIRST, the record next - a kill between them leaves "mirror sealed, record home" (the next signal opens it again),
        // never "record sealed, mirror home" (the engine would keep taking Personal writes that the pack does not hold). OPENING (home again, a commit) writes the record first, the mirror next.
        if (!ctx.deps.setMirror("sealed")) return wait(userId, "mirror_unavailable");
        if (m.blocker) patchMove(userId, { blocker: undefined });
        crash("sender:approved:after-mirror");
        const record = ctx.load(userId)!;
        ctx.save(userId, { ...record, state: "sealed", move: { ...record.move!, step: "sealed", waiting: undefined, attempts: 0, counts: { ...(record.move!.counts ?? {}), activeWork: ctx.deps.activeWorkCount() } } });
        crash("sender:approved:after-record");
        crash("sender:sealed:after-mirror");
        return "again";
      }
      case "sealed": {
        if (!pinnedHolds(m, pm)) { setStep(userId, "asked", { pinned: undefined }); await reopen(userId); return wait(userId, "request_changed"); }
        const out = await ctx.call("move/sealed", "host", { moveId: m.moveId }, session, key);
        if (!out.ok) {
          if (out.code === "no_such_move" || out.code === "move_expired") { await closeMove(userId, out.code === "move_expired" ? "expired" : "cancelled", out.code); return "end"; }
          return wait(userId, out.unreachable ? "server_unreachable" : out.code);
        }
        crash("sender:sealed:after-server");
        setStep(userId, "packed"); return "again";
      }
      case "packed": {
        if (!pinnedHolds(m, pm)) { setStep(userId, "asked", { pinned: undefined }); await reopen(userId); return wait(userId, "request_changed"); }
        if (pm?.expired === true) { await closeMove(userId, "expired", "move_expired"); return "end"; }   // B6: an expired request is the end (the home opens again), not a wait that never ends
        const { workDir } = dirsOf(userId);
        if (m.packDir && fs_.existsSync(path.join(m.packDir, "manifest.json"))) { setStep(userId, "uploaded"); return "again"; }
        // A pack folder the record does not know (a run that died between packing and writing the record, finished or not): removed. `discardPacked` removes only a folder whose owner marker proves it is ours.
        try { for (const name of fs_.readdirSync(workDir)) if (name.startsWith("one-pack-") && path.join(workDir, name) !== m.packDir) discardPacked(path.join(workDir, name)); } catch { /* no folder yet */ }
        const host = ctx.deps.bundleHost(userId);
        const packed = await packOne(host, { workDir, caller: ctx.deps.caller(), maxBytes: m.bundleLimit ?? BUNDLE_LEGACY_LIMIT_BYTES, ...(m.engine100 ? { engine100: true } : {}), ...(m.memoryLimit ? { limitBytes: m.memoryLimit } : {}) });
        if (packed.state !== "packed" || !packed.dir) {
          // Audit 61 desktop 1: too large (an engine that could not measure): the home is opened again NOW and the request is cancelled, never a wait that only an expiry ends.
          // Repair 5 (engine `limit_in_answer`): the engine's own check named the size it takes. Strictly smaller than what was packed for: pack again under it, in part (an engine that packs in part); otherwise the end, with the code.
          const said = packed.limitBytes; const capNow = m.bundleLimit ?? BUNDLE_LEGACY_LIMIT_BYTES;
          if (packed.code === "store_too_large" && said !== undefined && said >= MIN_LIMIT_BYTES && said < capNow && (m.engine100 || m.memoryLimit)) {
            let mem: number | undefined; try { mem = memoryRoomBytes(host, said); } catch { mem = undefined; }
            setStep(userId, "packed", { packDir: undefined, bundleLimit: said, memoryLimit: mem }); return "again";
          }
          if (packed.code === "store_too_large") return stopSender(cur, "store_too_large");
          return wait(userId, packed.code ?? "pack_failed");
        }
        crash("sender:packed:after-pack");
        let ids: string[] = [];
        try { const parsed = JSON.parse(fs_.readFileSync(path.join(packed.dir, "purge-ids.json"), "utf8")) as unknown; if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === "string"); } catch { ids = []; }
        const leftNow = packed.notPacked?.byReason.over_size_limit;
        const counts = { ...(m.counts ?? {}), ...(m.memoryLimit ? { movedRows: packed.manifest?.counts.memoryRows ?? 0, leftRows: leftNow ?? (m.counts?.leftRows ?? 0), rows: (packed.manifest?.counts.memoryRows ?? 0) + (leftNow ?? (m.counts?.leftRows ?? 0)) } : {}), packedMessages: packed.manifest?.counts.messages ?? 0, movedLines: packed.manifest?.counts.messages ?? 0, leftLines: packed.manifest?.droppedMessages ?? 0, ...Object.fromEntries(Object.entries(packed.notPacked?.byReason ?? {}).map(([k, v]) => [`leftBy_${k}`, v])),
          // Repair 5 (engine `priority_order`): lines packed / left per kind tier (counts only; the same `<name>_<tier>` shape as `leftBy_`).
          ...Object.fromEntries(Object.entries(packed.packedBy ?? {}).map(([k, v]) => [`packedBy_${k}`, v])), ...Object.fromEntries(Object.entries(packed.leftBy ?? {}).map(([k, v]) => [`leftByKind_${k}`, v])), packedMemoryRows: packed.manifest?.counts.memoryRows ?? 0, notPacked: packed.notPacked?.count ?? 0, stampsNotPacked: packed.stampsNotPacked ?? 0, droppedMessages: packed.manifest?.droppedMessages ?? 0, droppedEmbeddings: packed.manifest?.droppedEmbeddings ? 1 : 0 };
        const purgeIds = JSON.stringify(ids).length <= 2 * MIB ? ids : undefined;     // above 2 MiB only the folder's own list is trusted
        setStep(userId, "uploaded", { packDir: packed.dir, packId: packed.packId, counts, ...(purgeIds ? { purgeIds } : {}) });
        return "again";
      }
      case "uploaded": {
        if (!pinnedHolds(m, pm)) { setStep(userId, "asked", { pinned: undefined }); await reopen(userId); return wait(userId, "request_changed"); }
        const p = m.pinned!;
        if (pm?.expired === true) { await closeMove(userId, "expired", "move_expired"); return "end"; }   // B6: no 9 MiB put against a request that is already gone
        if (!m.packDir || !fs_.existsSync(path.join(m.packDir, "manifest.json"))) { setStep(userId, "packed", { packDir: undefined }); return "again"; }
        // Security follow-up S2: the bytes this computer locked are written down (file + sha-256 in the record) BEFORE they are sent, and K_rej is bound to that sha-256. When the pointer already holds those bytes
        // (the answer to `move/uploaded` was lost) nothing is locked again; a new lock never overwrites an older K_rej.
        // Audit 59 F-2: the pointer shows bytes of THIS move that THIS computer's key uploaded (`senderPub` is the pinned key): they are the bytes, whatever the record says about its own lock (a record restored from a backup has no `sealedSha`):
        // go on from `left` with the pointer's sha-256 (the purge picks the `krej.<sha>` that goes with it). Locking again would make new bytes the server answers `wrong_phase` to, for ever.
        if (pm?.phase === "uploaded" && typeof pm.sha256 === "string" && SHA_RE.test(pm.sha256) && (pm.sha256 === m.sealedSha || pm.senderPub === p.senderPub)) { setStep(userId, "left", { uploadedSha: pm.sha256, ...(m.sealedSha ? {} : { sealedSha: pm.sha256 }) }); return "again"; }
        const sealedFile = path.join(m.packDir, SEALED_FILE);
        // Audit 62 / the locked bytes are checked in the FILE (read in pieces) and sent from it as a stream: a 100 MiB bundle is not held in memory for the check or for the request.
        let len = 0; let sha = m.sealedSha && SHA_RE.test(m.sealedSha) ? m.sealedSha : null;
        if (sha && ctx.deps.secrets.exists(userId, p.moveId, krejName(sha))) { const f = fileSha(sealedFile); if (f && f.sha256 === sha) len = f.size; }
        if (!len) {
          const files = [...BUNDLE_FILES, "manifest.json"].filter((n) => fs_.existsSync(path.join(m.packDir!, n))).map((name) => ({ name, bytes: fs_.readFileSync(path.join(m.packDir!, name)) }));
          let sealed: ReturnType<typeof sealBundle>;
          try { sealed = sealBundle(files, { moveId: p.moveId, toPub: p.toPub, boxPub: p.boxPub, senderPub: p.senderPub }); } catch (e) { return stopSender(cur, String((e as Error).message || "seal_failed")); }
          if ("invalid" in sealed) return stopSender(cur, sealed.invalid);
          if (sealed.bytes.length > BUNDLE_WIRE_MAX) return stopSender(cur, "bundle_too_large");
          // K_rej (under the bytes' own sha-256) and the bytes first, the record next, the upload last: a bundle that is on the server always has its key here, and a kill anywhere finds the same bytes again
          if (!ctx.deps.secrets.write(userId, p.moveId, krejName(sealed.sha256), sealed.krej)) return wait(userId, "key_storage_unavailable");
          const tmp = `${sealedFile}.${randomBytes(4).toString("hex")}.tmp`;
          fs_.writeFileSync(tmp, sealed.bytes, { mode: 0o600 }); fs_.renameSync(tmp, sealedFile);
          patchMove(userId, { sealedSha: sealed.sha256 });
          crash("sender:uploaded:after-seal-record");
          len = sealed.bytes.length; sha = sealed.sha256;
        }
        if (!(pm?.phase === "uploaded" && pm.sha256 === sha)) {
          const put = await ctx.putBundle(session, key, { moveId: p.moveId, sha256: sha!, bytes: len }, { file: sealedFile });
          if (!put.ok) {
            if (put.code === "move_expired" || put.code === "no_such_move") { await closeMove(userId, put.code === "move_expired" ? "expired" : "cancelled", put.code); return "end"; }
            // Audit 62 / a server from before 100 MiB refuses a bundle over 9 MiB (`bundle_too_large`, before it reads the body). Not an end and not a wait for ever: this move is packed AGAIN at the legacy limit (in part when the store needs it; the rest stays here)
            // and put again. The next moves of this run start at the legacy limit.
            // Repair 5 (web `1de5f72d`): the refusal now NAMES the server's limit (`limitBytes`, wire bytes: the bundle is that minus the wire's 1 MiB); a server that names none is the one from before 100 MiB (legacy 8 MiB). Strictly smaller than what was packed
            // for, or the end with the code - the same size is never packed again (the old code waited here for ever when the legacy size was refused).
            if (put.code === "bundle_too_large") {
              const cap = m.bundleLimit ?? BUNDLE_LEGACY_LIMIT_BYTES;
              const said = put.body && typeof put.body.limitBytes === "number" && Number.isSafeInteger(put.body.limitBytes) ? put.body.limitBytes : undefined;
              const target = said !== undefined ? said - MIB : cap > BUNDLE_LEGACY_LIMIT_BYTES ? BUNDLE_LEGACY_LIMIT_BYTES : undefined;
              if (target !== undefined && target >= MIN_LIMIT_BYTES && target < cap) {
                serverBundleCap = target; if (m.packDir) discardPacked(m.packDir);
                let mem: number | undefined; if (m.engine100 || m.memoryLimit) { try { mem = memoryRoomBytes(ctx.deps.bundleHost(userId), target); } catch { mem = undefined; } }
                setStep(userId, "packed", { packDir: undefined, sealedSha: undefined, uploadedSha: undefined, bundleLimit: target, memoryLimit: mem });
                return "again";
              }
              return stopSender(cur, "bundle_too_large");
            }
            // Repair 5 (web W-8): `conflict` = two uploads of the account overlapped and this one was not stored: the SAME put again, at most twice in a row (`attempts`), then the usual wait.
            if (put.code === "conflict" && (m.attempts ?? 0) < 2) { patchMove(userId, { attempts: (m.attempts ?? 0) + 1 }); return "again"; }
            // Repair 5 (web `request_timeout`, 408, `retryable`: `body_stalled` | `body_too_slow`; or this computer's own drop after a long slow send): the same put again after a growing wait; the SECOND one for the same bundle packs it again at HALF the size
            // (never below 8 MiB: the newest lines go, the rest stay here, in part) - a slow line cannot hold a 100 MiB move for ever. At 8 MiB the line itself is the cause: the wait grows to 5 minutes and the request's expiry is the end.
            if (put.code === "request_timeout") {
              const slow = (m.slowPuts ?? 0) + 1;
              if (slow >= 2 && len > BUNDLE_LEGACY_LIMIT_BYTES) {
                const target = Math.max(BUNDLE_LEGACY_LIMIT_BYTES, Math.floor(len / 2));
                if (m.packDir) discardPacked(m.packDir);
                let mem: number | undefined; if (m.engine100 || m.memoryLimit) { try { mem = memoryRoomBytes(ctx.deps.bundleHost(userId), target); } catch { mem = undefined; } }
                setStep(userId, "packed", { packDir: undefined, sealedSha: undefined, uploadedSha: undefined, bundleLimit: target, memoryLimit: mem, slowPuts: 0 });
                return "again";
              }
              patchMove(userId, { slowPuts: slow, retryAt: ctx.now() + backoffMs(slow, 10_000) });
              return wait(userId, "request_timeout");
            }
            noteRetryAfter(userId, put);   // `server_storage_full` (503, `retryAfterSeconds`): the SAME call again at that moment (the one deadline timer), not a poll
            return wait(userId, put.unreachable ? "server_unreachable" : put.code);
          }
          crash("sender:uploaded:after-put");
          const up = await ctx.call("move/uploaded", "host", { moveId: p.moveId, bytes: len, sha256: sha!, senderPub: p.senderPub }, session, key);
          if (!up.ok) { if (up.code === "move_expired" || up.code === "no_such_move") { await closeMove(userId, up.code === "move_expired" ? "expired" : "cancelled", up.code); return "end"; } return wait(userId, up.unreachable ? "server_unreachable" : up.code); }
        }
        crash("sender:uploaded:after-uploaded");
        setStep(userId, "left", { uploadedSha: sha! }); return "again";
      }
      case "left": {
        const p = m.pinned!;
        const record = ctx.load(userId)!;
        if (pointer.home.kind === "desktop" && pointer.home.hostId === p.toHostId && pointer.pub === p.toPub && pointer.epoch > (record.epoch ?? -1)) {
          // Audit 59 B5 (reviewed): this write is NOT the receiving side's hole. The receiver here is the one the owner pressed [move] for (pinned: its key and box key, `boxSig` verified, the pointer names exactly that key), so it is a computer the
          // owner chose. A home that merely waited its way in has another key and never gets here. The purge still waits for a `confirmed` home (`purged`: `home_unconfirmed`), so nothing is deleted for an unconfirmed one.
          const seen = [...(record.seenHomes ?? []).filter((h) => h.hostId !== p.toHostId), { hostId: p.toHostId, pub: p.toPub }].slice(-8);
          const label = typeof pointer.home.label === "string" ? pointer.home.label : undefined;
          ctx.deps.setMirror("away");                       // closing: the engine mirror first (see `approved`), the record next
          crash("sender:left:after-mirror");
          const { leftoverBox: _box, ...keepRecord } = record;   // a computer that left the home keeps no old-record box key (F-14)
          ctx.save(userId, { ...keepRecord, state: "away", epoch: pointer.epoch, ...(seen.length ? { seenHomes: seen } : {}), ...(label ? { homeLabel: label } : {}), move: { ...record.move!, step: "purged", waiting: undefined, attempts: 0, purgeWaitSince: ctx.now() } });
          ctx.forgetHomeBox?.(userId);
          crash("sender:left:after-record");
          return "again";
        }
        if (pm?.phase === "uploaded" && typeof pm.sha256 === "string" && SHA_RE.test(pm.sha256) && m.uploadedSha !== pm.sha256) patchMove(userId, { uploadedSha: pm.sha256 });   // the bytes the receiver will open: the key that goes with them is the one the purge uses
        if (pointer.home.kind === "desktop" && pointer.home.hostId === key.hostId && !pm) { await closeMove(userId, "cancelled", "request_gone"); return "end"; }
        // Repair 5: the request this computer uploaded for is GONE and another request of the receiving computer stands in its place (it cancelled and started again - under a smaller size, or after a failure) while this computer is still the home: this move is over
        // (the server commits only the request it was uploaded for), the home opens again and the new request is asked about as a new one. Before this the sender waited for the old request (`waiting_receiver`) for ever.
        if (pm && pm.moveId !== m.moveId && pointer.home.kind === "desktop" && pointer.home.hostId === key.hostId && pointer.pub === key.pub) { await closeMove(userId, "replaced", "request_changed"); return "end"; }
        if (pm?.expired === true) { await closeMove(userId, "expired", "move_expired"); return "end"; }
        return wait(userId, "waiting_receiver");
      }
      case "purged": {
        const p = m.pinned!;
        const record = ctx.load(userId)!;
        // A home that "waited its way in" was reverted: this computer is the home again. Nothing was deleted (the purge waits for a confirmed home); the move is over.
        if (pointer.home.kind === "desktop" && pointer.home.hostId === key.hostId && pointer.pub === key.pub && last?.mode === "revert") {
          const { homeLabel: _label, ...rest } = record;
          ctx.save(userId, { ...rest, state: "home", epoch: pointer.epoch });
          ctx.deps.setMirror("home");
          await closeMove(userId, "stopped", "reverted"); return "end";
        }
        // Audit 59 F-5: the wait for the receiver (its import, the trust in it) has an end. Past 30 days the pack folder (a copy of the text in the clear) goes and the purge stays undone: the move ends `stopped` / `purge_expired`,
        // this computer is `away`, and NOTHING in its memory is deleted.
        if (!m.purgeDone && ctx.now() - (m.purgeWaitSince ?? m.startedAt) > PURGE_WAIT_MAX_MS) { await closeMove(userId, "stopped", "purge_expired"); return "end"; }
        if (!m.purgeDone) {
          const trusted = (record.seenHomes ?? []).some((h) => h.hostId === p.toHostId && h.pub === p.toPub);
          if (!last || last.moveId !== p.moveId || !last.importedAt) { await maybeRedeposit(cur, m, last); return wait(userId, "waiting_import"); }
          if (!trusted || pointer.pub !== p.toPub) return wait(userId, "new_home_not_trusted");
          if (pointer.homeTrust === "unconfirmed") return wait(userId, "home_unconfirmed");
          // Audit 61 desktop 2 (contract one-home-move §2.8): the count and the list the server shows are the NEW home's own statement only if its signature on `move/imported` holds, checked with the key this computer wrote down for that home at `left` (the owner pressed
          // [move] for exactly that key; never the pointer's `to.pub`). No proof, or a false one: nothing is deleted, the pack folder goes, this computer is `away` (`imported_not_trusted`: the lines stay here, only the amount deleted shrinks).
          const homeKey = (record.seenHomes ?? []).find((h) => h.hostId === p.toHostId && h.pub === p.toPub)?.pub;
          if (!homeKey || !importedProofHolds(userId, last, homeKey)) { await closeMove(userId, "stopped", "imported_not_trusted"); return "end"; }
          // Audit 59 F-2: the K_rej of the bytes the receiver opened: the pointer's sha-256 as `left` wrote it down (`uploadedSha`), the record's own lock next; with neither, the move's only `krej.*` (a wrong one can only make the masked ids not match: nothing is deleted).
          const purgeSha = m.uploadedSha ?? m.sealedSha;
          let krej = purgeSha && SHA_RE.test(purgeSha) ? ctx.deps.secrets.read(userId, p.moveId, krejName(purgeSha)) : null;
          if (!krej) { const names = ctx.deps.secrets.krejNames(userId, p.moveId); if (names.length === 1) krej = ctx.deps.secrets.read(userId, p.moveId, names[0]); }
          const maskedList = Array.isArray(last.rejectedIds) ? last.rejectedIds.filter((x): x is string => typeof x === "string") : [];
          const truncated = last.rejectedIdsTruncated === true;
          // Audit 59 B7: the count `last.rejected` is the receiver's statement "I refused this many"; ABSENT is not zero. A server that drops the field (an older one, or a record past its keeping time) leaves the sender not knowing which lines
          // arrived: nothing is deleted. Only a written number (0 included) says how many.
          const rejectedKnown = typeof last.rejected === "number";
          const rejectedCount = rejectedKnown ? last.rejected as number : 0;
          const incomplete = !rejectedKnown || truncated || (rejectedCount !== maskedList.length) || (rejectedCount > 0 && !krej);
          let ids = m.purgeIds ?? [];
          if (!ids.length && m.packDir) { try { const parsed = JSON.parse(fs_.readFileSync(path.join(m.packDir, "purge-ids.json"), "utf8")) as unknown; if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === "string"); } catch { /* no list */ } }
          if (!m.packDir || !fs_.existsSync(m.packDir)) { await closeMove(userId, "stopped", "purge_folder_missing"); return "end"; }   // nothing is deleted without the pack folder (kept at most 30 days)
          if (incomplete) { await closeMove(userId, "stopped", "rejected_ids_incomplete"); return "end"; }   // away, nothing deleted, the folder (a copy of the text) goes
          const set = new Set(maskedList);
          const keepIds = rejectedCount > 0 && krej ? [...new Set(ids)].filter((id) => set.has(maskId(krej!, id))) : [];
          if (rejectedCount > 0 && keepIds.length !== rejectedCount) { await closeMove(userId, "stopped", "rejected_ids_incomplete"); return "end"; }   // S2: the masked ids must account for EVERY refused line, or nothing is deleted
          const purge = await purgePacked(m.packDir, { caller: ctx.deps.caller(), retryPauseMs: ctx.deps.pauseMs ?? 1000, keepIds, rejectedIdsTruncated: truncated, expectedKept: rejectedCount });
          if (purge.state === "refused") { await closeMove(userId, "stopped", purge.code ?? "purge_refused"); return "end"; }
          if (purge.state !== "purged") return wait(userId, purge.code ?? "purge_remaining");
          // Audit 59 F-3: the purge is DONE here (the engine deleted the lines, the folder with the id list is gone): that fact and its counts are written BEFORE `move/purged` is told. A failed tell is read again at the next signal and
          // tells only that; it is never the false end `purge_folder_missing`.
          patchMove(userId, { purgeDone: true, counts: { ...(m.counts ?? {}), purged: purge.purged ?? 0, purgeKept: purge.kept ?? 0, alreadyGone: purge.alreadyGone ?? 0, purgeSkipped: purge.skippedTotal ?? 0 } });
          crash("sender:purged:after-purge");
        }
        const out = await ctx.call("move/purged", "host", { moveId: p.moveId }, session, key);
        if (!out.ok && out.code !== "no_such_move") return wait(userId, out.unreachable ? "server_unreachable" : out.code);
        const host = ctx.deps.bundleHost(userId);
        const left = describeLeftBehind(host);
        const beforeChat = boundPersonalChat(host.db, host.oneId);
        ctx.deps.unbindPersonalChat();       // the conversation is not deleted line by line: it is only no longer the personal conversation ("before the move")
        if (beforeChat) { const cur2 = ctx.load(userId); if (cur2) ctx.save(userId, { ...cur2, beforeMove: { chatId: beforeChat, at: ctx.now() } }); }
        const fresh = ctx.load(userId)?.move;
        // Audit 61 (desktop 10): the purge is done and told; the pack folder (a copy of the moved text in the clear) must not outlive it. `purgePacked` removes it itself; a folder that was left (a removal that failed) goes here, before the record forgets its name.
        if (m.packDir) discardPacked(m.packDir);
        patchMove(userId, { packDir: undefined, counts: { ...(fresh?.counts ?? m.counts ?? {}), leftConversationMessages: left.counts.conversationMessages, leftActiveWork: left.counts.activeWork } });
        await closeMove(userId, "done"); return "end";
      }
      default: return wait(userId, "step_unknown");
    }
  }
  async function reopen(userId: string): Promise<void> {
    const record = ctx.load(userId);
    if (record?.state === "sealed") { ctx.save(userId, { ...record, state: "home" }); ctx.deps.setMirror("home"); }
  }
  async function stopSender(cur: NonNullable<ReturnType<typeof current>>, code: string, numbers?: { rows?: number; estimatedBytes?: number; limitBytes?: number }): Promise<Outcome> {
    const m = cur.record.move!;
    if (m.moveId) await ctx.call("move/cancel", "host", { moveId: m.moveId }, cur.session, cur.key);
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(numbers ?? {})) if (typeof v === "number") counts[k] = v;
    await closeMove(cur.userId, "stopped", code, Object.keys(counts).length ? counts : undefined); return "end";
  }

  /**
   * Audit 59 B11: the receiver has not imported for about a day after its commit and the server may have dropped the held bundle (24-hour expiry, the fetches used up). The sending home still has the locked bytes (`sealed.bin`, in the pack
   * folder that waits for the purge): it puts the SAME bytes again (same sha-256: the server accepts only those, `already` when they are still held; at most three times for a move, `last.reputs`). The pointer shows no "held" flag, so this is time-based:
   * no sooner than 23 hours after the commit, then 23 hours apart, three times at most. A put that did not reach the server (unreachable) does not count.
   */
  async function maybeRedeposit(cur: NonNullable<ReturnType<typeof current>>, m: MoveRecord, last: ReturnType<typeof plast>): Promise<void> {
    const p = m.pinned; if (!p || !last || last.moveId !== p.moveId || last.importedAt || (last as { mode?: string }).mode !== "move") return;
    if ((m.redeposits ?? 0) >= REDEPOSIT_MAX || !m.packDir) return;
    const atRaw = (last as { at?: unknown }).at; const at = typeof atRaw === "number" ? atRaw : typeof atRaw === "string" ? Date.parse(atRaw) : NaN;
    const now = ctx.now();
    // Audit 61 desktop 3 (web `a500da29`, pointer §18.2): the server says whether it still holds the bytes. `true`: nothing to do. `false`: put them now (no 23-hour wait; a look at most once in REDEPOSIT_RETRY_MS, so a refusing server is not asked at every signal).
    // No value (an older server, a move from the server): the time rule below stays as the safety net.
    if (last.bundleHeld === true) return;
    if (last.bundleHeld === false) { if (m.redepositAt !== undefined && now - m.redepositAt < REDEPOSIT_RETRY_MS) return; }
    else if (!Number.isFinite(at) || now - at < REDEPOSIT_AFTER_MS || (m.redepositAt !== undefined && now - m.redepositAt < REDEPOSIT_AFTER_MS)) return;
    const sha = m.uploadedSha ?? m.sealedSha; if (!sha || !SHA_RE.test(sha)) return;
    const sealedPath = path.join(m.packDir, SEALED_FILE);
    const f = fileSha(sealedPath);
    if (!f || f.sha256 !== sha || f.size > BUNDLE_WIRE_MAX) return;
    const put = await ctx.putBundle(cur.session, cur.key, { moveId: p.moveId, sha256: sha, bytes: f.size }, { file: sealedPath });
    // Audit 61 (desktop 4): `already` = the server still HOLDS the bytes (nothing was put): not one of the three. The next look is a day later, as after any put.
    // Only a put the server STORED counts (web: a failed body and `already` are not counted there either). A refusal (429: "this key's own 60 per 10 minutes"), an unreachable server: no count, the next look is after the throttle - signals only, no timer.
    if (put.ok && put.result !== "already") patchMove(cur.userId, { redepositAt: now, redeposits: (m.redeposits ?? 0) + 1 });
    else patchMove(cur.userId, { redepositAt: now });
  }

  /**
   * Audit 59 F-1: the owner's answer to "the home's key is not the one I wrote down": this computer takes the key the pointer shows for that home as the one it knows. A request only (the yes is the confirmation window's).
   * Valid only while a computer-to-computer move waits with `home_key_changed`; the yes re-checks that the home and its key are still the ones the owner was shown.
   */
  function requestAcceptHomeKey(): { ok: boolean; code?: string; requestId?: string } {
    const cur = current(); if (!cur) return { ok: false, code: "sign_in_required" };
    if (!ctx.writesOpen()) return { ok: false, code: "device_proof_unavailable" };
    const m = cur.record.move; const pointer = ctx.pointer();
    if (!m || m.role !== "receiver" || m.from !== "desktop" || m.waiting !== "home_key_changed" || !pointer || pointer.home.kind !== "desktop" || !pointer.pub) return { ok: false, code: "no_such_request" };
    const seenHost = pointer.home.hostId; const seenPub = pointer.pub; const userId = cur.userId;
    return ctx.confirm.request("acceptHomeKey", { label: pointer.home.label ?? null }, async () => {
      const now = ctx.pointer(); const rec = ctx.load(userId);
      if (!now || now.home.kind !== "desktop" || now.home.hostId !== seenHost || now.pub !== seenPub || rec?.move?.waiting !== "home_key_changed") return { ok: false, code: "request_changed" };
      ctx.save(userId, { ...rec, seenHomes: [...(rec.seenHomes ?? []).filter((h) => h.hostId !== seenHost), { hostId: seenHost, pub: seenPub }].slice(-8) });
      void drive().catch(() => undefined);
      return { ok: true };
    });
  }

  /** The owner's [move] (from the confirmation window) or a trusted phone's approval: pins (moveId, to.pub, boxPub, senderPub) and checks the receiver's `boxSig`. */
  function approveNow(userId: string, by: "owner" | "phone", expectMoveId?: string): { ok: boolean; code?: string } {
    const record = ctx.load(userId); const key = ctx.keyed(userId); const pointer = ctx.pointer();
    if (!record?.move || !key || !pointer) return { ok: false, code: "no_such_move" };
    const m = record.move; const pm = pmove(pointer);
    if (m.role !== "sender" || m.step !== "asked" || !pm?.moveId || (m.moveId && pm.moveId !== m.moveId) || (expectMoveId && pm.moveId !== expectMoveId)) return { ok: false, code: "no_such_move" };
    if (record.state !== "home" || !(pointer.home.kind === "desktop" && pointer.home.hostId === key.hostId && pointer.pub === key.pub)) return { ok: false, code: "not_home" };
    const to = pm.to;
    if (!to?.pub || !to.hostId || !to.boxPub || !to.boxSig) return { ok: false, code: "box_missing" };
    if (!verifyBoxSig(to.pub, userId, to.hostId, to.boxPub, to.boxSig)) return { ok: false, code: "box_signature_invalid" };
    if (!pointer.pub) return { ok: false, code: "home_key_missing" };
    ctx.save(userId, { ...record, move: { ...m, moveId: pm.moveId, step: "approved", approvedBy: by, waiting: undefined, attempts: 0, pinned: { moveId: pm.moveId, toPub: to.pub, boxPub: to.boxPub, senderPub: pointer.pub, toHostId: to.hostId } } });
    return { ok: true };
  }

  /** [move] (the number is shown in the confirmation window only). The owner window asks; the yes runs from the confirmation window and re-checks that the request is still the one the number was made from. */
  function requestApproveMove(arg: { moveId?: string }): { ok: boolean; code?: string; requestId?: string } {
    const cur = current(); if (!cur) return { ok: false, code: "sign_in_required" };
    if (!ctx.writesOpen()) return { ok: false, code: "device_proof_unavailable" };
    const m = cur.record.move; const pm = pmove(ctx.pointer());
    if (!m || m.role !== "sender" || m.step !== "asked" || !pm?.moveId || !pm.to?.pub) return { ok: false, code: "no_such_move" };
    if (arg.moveId !== undefined && arg.moveId !== pm.moveId) return { ok: false, code: "no_such_move" };
    const seenId = pm.moveId; const seenPub = pm.to.pub; const userId = cur.userId;
    return ctx.confirm.request("approveMove", { confirmCode: ctx.confirmCode(seenId, seenPub), label: pm.to.label ?? null, activeWork: ctx.deps.activeWorkCount() }, async () => {
      const now = pmove(ctx.pointer());
      if (!now || now.moveId !== seenId || now.to?.pub !== seenPub) return { ok: false, code: "no_such_move" };   // the request changed after the number was shown: nothing is sealed
      const r = approveNow(userId, "owner", seenId);
      if (r.ok) void drive().catch(() => undefined);
      return r;
    }, () => declineMove({ moveId: seenId }));   // the window's "this wasn't me": the same refusal as [it was not me] on the card
  }
  /** [it was not me]: cancels the request (a refusal hands over nothing). */
  async function declineMove(arg: { moveId?: string }): Promise<{ ok: boolean; code?: string }> {
    const cur = current(); if (!cur) return { ok: false, code: "sign_in_required" };
    const m = cur.record.move;
    if (!m || m.role !== "sender" || m.step !== "asked") return { ok: false, code: "no_such_move" };
    const sent = ctx.writesOpen();   // a refusal that could only be closed here (the writes are shut, the server did not answer) is not told as done
    const out = await cancelMove(arg);
    if (out.ok && sent && out.code !== "cancelled_locally") { try { ctx.answered?.("declined"); } catch { /* a card never changes the refusal */ } }
    return out;
  }
  function confirmBlank(arg: { count: unknown; moveId?: string }): { ok: boolean; code?: string; count?: number } {
    const cur = current(); if (!cur) return { ok: false, code: "sign_in_required" };
    const m = cur.record.move;
    if (!m?.blankAsk) return { ok: false, code: "no_question" };
    if (arg.moveId !== undefined && arg.moveId !== m.moveId) return { ok: false, code: "no_such_move" };
    if (!Number.isSafeInteger(arg.count) || arg.count !== m.blankAsk.count) return { ok: false, code: "count_changed", count: m.blankAsk.count };
    patchMove(cur.userId, { confirmBlank: m.blankAsk.count, blankAsk: undefined, waiting: undefined });
    void drive().catch(() => undefined);
    return { ok: true };
  }

  // ── owner presses ──
  async function cancelMove(arg: { moveId?: string }): Promise<{ ok: boolean; code?: string }> {
    const cur = current(); if (!cur) return { ok: false, code: "sign_in_required" };
    const m = cur.record.move; if (!m) return { ok: false, code: "no_such_move" };
    if (arg.moveId !== undefined && m.moveId !== arg.moveId) return { ok: false, code: "no_such_move" };
    if (!ctx.writesOpen()) {
      // Audit 59 B6: the owner's cancel is local state first. With the writes shut nothing can be told to the server (the request ends by its own expiry there), but this computer must not stay held:
      // a receiver, or a sender that has not sealed, cancels locally; a SEALED sender only when the server itself shut the writes and the pointer does not name another computer as the home (that would be the committed move).
      if (cur.record.state === "sealed" && m.role === "sender") {
        if (!ctx.serverShut?.()) return { ok: false, code: "device_proof_unavailable" };
        let fresh = false;
        shutReading = true; try { fresh = await ctx.readPointer().catch(() => false); } finally { shutReading = false; }
        const pointer = ctx.pointer();
        if (!fresh && !pushedNothing(m.step)) return { ok: false, code: "pointer_unavailable" };   // N-1: after the put only a pointer read just now may say that no other computer is the home
        if (pointer && !(pointer.home.kind === "desktop" && pointer.home.hostId === cur.key.hostId && pointer.pub === cur.key.pub)) return { ok: false, code: "already_committed" };
      } else if (!ctx.pointer() && !ctx.serverShut?.()) return { ok: false, code: "device_proof_unavailable" };
      const cleanLocal = await closeMove(cur.userId, "cancelled");
      return { ok: cleanLocal, ...(cleanLocal ? {} : { code: "cleanup_incomplete" }) };
    }
    if (m.moveId && m.step !== "reported") {
      const out = await ctx.call("move/cancel", "host", { moveId: m.moveId }, cur.session, cur.key);
      if (!out.ok) {
        if (out.code === "already_committed") return { ok: false, code: "already_committed" };
        // Audit 62 (home X1): a server that is DOWN (no answer, a 5xx) must not hold the owner's cancel - nor a sealed personal agent closed until it comes back. Where no commit can exist, the cancel is local first: a sender that has not put its bytes
        // (`asked`, `approved`, `sealed`, `packed`: the receiver commits only bytes that were put) and a receiver that has not committed (`claimed` .. `checked`). The request ends by its own expiry on the server; this computer opens again NOW.
        const down = out.unreachable === true || (typeof out.status === "number" && out.status >= 500);
        const noCommitPossible = m.role === "sender" ? (m.step === "asked" || m.step === "approved" || pushedNothing(m.step)) : (m.step === "claimed" || m.step === "requested" || m.step === "sealed" || m.step === "fetched" || m.step === "checked");
        if (down && noCommitPossible) {
          const cleanDown = await closeMove(cur.userId, "cancelled", "cancelled_locally");
          return { ok: cleanDown, code: cleanDown ? "cancelled_locally" : "cleanup_incomplete" };
        }
        if (out.code !== "no_such_move" && out.code !== "move_expired") return { ok: false, code: out.unreachable ? "server_unreachable" : out.code };
      }
    }
    const clean = await closeMove(cur.userId, "cancelled");
    return { ok: clean, ...(clean ? {} : { code: "cleanup_incomplete" }) };
  }

  function answerProfile(keep: unknown): { ok: boolean; code?: string } {
    const cur = current(); if (!cur) return { ok: false, code: "sign_in_required" };
    const ask = profileAsk.get(cur.userId);
    if (!ask) return { ok: false, code: "no_question" };
    if (keep !== "here" && keep !== "incoming") return { ok: false, code: "invalid_args" };
    profileAsk.delete(cur.userId);
    if (keep === "incoming") { try { ctx.deps.applyProfile({ ...(ask.incoming.displayName ? { displayName: ask.incoming.displayName } : {}), ...(ask.incoming.avatarIcon ? { avatarIcon: ask.incoming.avatarIcon } : {}), ...((ask.incoming as { profileContext?: string }).profileContext ? { profileContext: (ask.incoming as { profileContext?: string }).profileContext } : {}) }); } catch { return { ok: false, code: "not_applied" }; }
    }
    return { ok: true };
  }

  // ── what the screen may see: steps, counts, codes. No id, no key, no number. ──
  function view(userId: string | null): { move: Record<string, unknown> | null; lastMove: LastMove | null; readyBlock: Record<string, unknown> | null; profileQuestion: { here: { displayName: string; avatarIcon: string }; incoming: { displayName?: string; avatarIcon?: string } } | null } {
    const record = userId ? ctx.load(userId) : null;
    const m = record?.move;
    return {
      move: m ? { role: m.role, from: m.from, step: m.step, startedAt: m.startedAt, ...(m.waiting ? { waiting: m.waiting } : {}), ...(m.counts ? { counts: m.counts } : {}), ...(m.blankAsk ? { blankAsk: { count: m.blankAsk.count } } : {}), ...(m.approvedBy ? { approvedBy: m.approvedBy } : {}),
        // Audit 62 (§6.1): what a screen cannot know from the step and the code alone - only moments, counts and kinds (no id, no key, no text from the server).
        ...(m.waitSince !== undefined ? { waitSince: m.waitSince } : {}), ...(m.importingSince !== undefined ? { importingSince: m.importingSince } : {}), ...(m.bundleLimit !== undefined ? { bundleLimit: m.bundleLimit } : {}), ...(m.retryAt !== undefined ? { retryAt: m.retryAt } : {}), ...(m.signinWait ? { signinWait: m.signinWait } : {}), ...(m.waiting ? { waitKind: waitKindOf(m.waiting) } : {}),
        ...(m.blocker ? { blocker: { reason: m.blocker.reason, needs: m.blocker.needs, ...(m.blocker.hosts ? { hosts: m.blocker.hosts } : {}) } } : {}),
        ...(m.role === "sender" && m.step === "purged" ? { purgeWaitSince: m.purgeWaitSince ?? m.startedAt, purgeWaitUntil: (m.purgeWaitSince ?? m.startedAt) + PURGE_WAIT_MAX_MS, redepositsLeft: Math.max(0, REDEPOSIT_MAX - (m.redeposits ?? 0)) } : {}),
        ...(m.role === "receiver" && m.from === "desktop" && m.step === "imported" ? { importWaitUntil: importEndsAt(m) } : {}) } : null,
      lastMove: record?.lastMove ?? null,
      readyBlock: readyBlock ? { reason: readyBlock.reason, needs: readyBlock.needs, ...(readyBlock.hosts ? { hosts: readyBlock.hosts } : {}) } : null,
      profileQuestion: userId ? profileAsk.get(userId) ?? null : null,
    };
  }

  /** The conversation this away computer keeps read-only: the one it had before the move, or the one still bound (a taken-over home keeps it bound; the write gate refuses new lines). null = none. */
  function beforeChatId(userId: string | null): string | null {
    const record = userId ? ctx.load(userId) : null;
    if (!record) return null;
    if (record.beforeMove?.chatId) return record.beforeMove.chatId;
    try { const host = ctx.deps.bundleHost(userId!); return boundPersonalChat(host.db, host.oneId); } catch { return null; }
  }

  /** Sign-out and a change of account (desktop C item 6): the plaintext this machine unpacked for a RECEIVING move goes, for the plaintext that is fetched again by design. The record, the secrets, the keys and the sender's pack folder stay.
   *  - from another computer: `stagedDir` (the decrypted bundle). A missing staged folder is fetched again at `checked` (-> `fetched`) and at `imported` (B11: the server keeps the locked bundle until `imported`, the old home may put it again).
   *  - from the server, BEFORE the commit (steps `fetched`, `checked`): the export pages. `fetched` resumes by section; a `checked` record goes back to `fetched`. After the commit the pages are not fetched again by this code, so they stay (reported, not removed). */
  function dropPlaintext(userId: string): void {
    const r = ctx.load(userId); const m = r?.move;
    if (!m || m.role !== "receiver") return;
    if (m.from === "desktop" && m.stagedDir) { try { discardStaged(m.stagedDir); } catch { /* the next sweep tries again */ } }
    if (m.from === "server" && m.moveId && (m.step === "fetched" || m.step === "checked")) {
      let gone = false; try { gone = removeExportDir(dirsOf(userId).stagingBase, m.moveId); } catch { gone = false; }
      if (gone && m.step === "checked") { try { setStep(userId, "fetched"); } catch { /* the pages are fetched again at the next pass anyway */ } }
    }
  }
  return { nextDeadline, awaitingResponse, waitingOnLocalCause, beforeChatId, startMoveHere, dropPlaintext, requestAcceptHomeKey, cancelMove, declineMove, confirmBlank, requestApproveMove, noteIncoming, answerProfile, drive, confirmedHome, readiness, view, closeMove, sweep, syncMirror, profileAskKey, _handlers: { crash } };
}
export type HomeMove = ReturnType<typeof createHomeMove>;
