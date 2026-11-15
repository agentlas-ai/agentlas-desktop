/*
 * The leftover of a computer that is not the home (Agentlas 2.0 O-M4b, contracts/one-home-leftover.md and its "home-side rules" section,-memory-algorithm 5.8.9).
 * Plain module, no Electron import: `home.ts` builds it with a context (`LeftoverCtx`: the account, the pointer, signed calls, the local record) and the deps of home-move.ts
 * (`MoveDeps` + `deps.leftover`). A gate drives the same code with synthetic homes, a fake server and the real engine.
 *
 * Two halves, one signal (a pointer read), no timer, no model, no prompt text:
 *  SENDER (this computer is `away`): when the pointer's home is `confirmed` AND a home this computer has seen (`seenHomes`), pack the personal conversation text and the Personal lines
 *    (never the rules file, photos, files, check-ins or settings; the profile and the face only when this computer is the home that was taken over), lock them to the home's leftover box key,
 *    upload (`leftover`), and later - only with the proof (the pointer's `leftoverMerged` line with my kid and the sha-256 I uploaded) AND the trust (confirmed + seen) - purge the lines through the
 *    engine and leave the conversation as "conversation before the move". An unconfirmed or never-seen home: nothing is packed, sent or deleted; a value asks once.
 *  RECEIVER (this computer is the home): publish the leftover box key once, list, and merge only what comes from a sender it knows (a computer that was once the home, or one the home vouched
 *    for) - anything else (a key that merely aged) is a REQUEST that the owner answers in the Main confirmation window; nothing is downloaded before that yes. The merge goes through
 *    `importStaged` (the move's own write path, no side road). Merged lines carry an origin mark (memory: evidence `origin:leftover:<kid>:<sha16>`; conversation lines: an index file), which is
 *    what "forget everything that came from this computer" reads.
 *
 * Where things live and who deletes them (resource rule):
 *   record.leftover      sender state `packed -> uploaded -> merged` (+ `empty`). Read: this pass, status. Deleted: when this computer is not `away` any more (pack folder with it).
 *   <workDir>/one-pack-* the sender's pack folder (a copy of the text; `sealed.bin` = the locked bytes, so a re-upload is the same sha-256). Deleted: purge done, a changed home, an empty pack, a restart sweep.
 *   record.leftoverBox   the home's published box key (public half + epoch); the seed is a host-only secret file beside the device key (home-key-store.ts). Replaced: when the home's key or epoch changes.
 *   record.leftoverWork  the merge in progress (one at a time). Deleted: when it is reported or its item is gone from the server.
 *   record.leftoverDone  the last 16 merged (kid, packId): a record that comes again is not merged again (a conversation the owner deleted at home does not come back). Oldest out at 17.
 *   record.leftoverOk    the owner's [merge] presses for exact (kid, sha256) pairs, at most 8. Deleted: with the merge.
 * <userData>/one-leftover/<acct>/leftover-origins/<kid>.json the ids of conversation lines merged from that computer (+ `unmarked`/`gap`: lines that could not be marked, B3). Deleted: by "forget everything from this
 *                        computer" when nothing is left and nothing could not be marked.
 *   <workDir>/one-forget-*  the id list of one engine purge call of "forget everything" (a copy of ids, no text). Deleted: `finally` of that call, or `reclaimStaleDirs` when its owner process is gone.
 *   record.leftoverWork.marks  the ids the engine said it added, over every call of one merge (<= 1000 per call, 5 calls). Deleted: with the work, when the merge is reported.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { boundPersonalChat, checkStaged, discardPacked, reclaimStaleDirs, discardStaged, importStaged, packOne, purgeIdList, purgePacked, stageBundle, type BundleHost } from "./bundle";
import { BUNDLE_WIRE_MAX, boxPubFromSeed, generateBoxKeyPair, maskId, openLeftover, sealLeftover, signLeftoverBox, verifyLeftoverBoxSig } from "./transport";
import { applyHandedBack, type BundleSources, type HandedBack } from "./bundle-host";
import type { CallOut, HomeRecordView, MoveDeps, PointerLike, Session } from "./home-move";
import type { ConfirmGate } from "./home-confirm";
import { readLeftoverListItems } from "./home-pointer-read";

export type LeftoverState = "empty" | "packed" | "uploaded" | "merged";
export interface LeftoverRec {
  state: LeftoverState; at: number; former: boolean;
  homeHostId: string; homePub: string;
  packDir?: string; packId?: string; purgeIds?: string[];
  sha256?: string; bytes?: number; sealedToPub?: string; sealedToBox?: string; uploadedAt?: number;
  counts?: Record<string, number>;
  /** Set on `merged` when nothing was deleted because the refused lines could not be accounted for (`rejected_ids_incomplete`). */
  code?: string;
  /** Repair 5 (web W-5, `409 leftover_bytes_full`): the account's old records together fill the server's 101 MiB. A FACT, not a pause: the same upload is not repeated until the home has merged something (the pointer's `leftoverMerged` changed: `sig`) or a day has passed
   * (the held records of the other computers expire after 7 days; one look per day at most, on a signal). `heldBytes` / `limitBytes` are the server's numbers. Deleted: with the record (`uploaded`, `merged`, `dropSender`). */
  full?: { at: number; sig: string; heldBytes?: number; limitBytes?: number };
}
const FULL_RETRY_MS = 24 * 3_600_000;
const mergedSig = (p: PointerLike): string => JSON.stringify([p.epoch, (Array.isArray(p.leftoverMerged) ? p.leftoverMerged : []).map((m) => { const r = rec(m); return `${String(r?.kid)}:${String(r?.sha256)}`; })]);
export interface LeftoverBoxRec { boxPub: string; epoch: number; pub: string }
export interface LeftoverWork {
  kid: string; sha256: string; hostId: string; startedAt: number; step: "staged" | "imported";
  /** What the engine refused, masked with K_rejL (22 characters each, at most 200). Kept with the work until it is reported. */
  rejected?: { count: number; ids: string[]; truncated: boolean };
  stagedDir?: string; packId?: string; preMem?: string[]; preLines?: string[]; counts?: Record<string, number>;
  attempts?: number;
  /** The engine's estimate of the lines this home has no room for (`wouldStoreFull` of `check`), kept for the screen while the merge is in progress. */
  wouldStoreFull?: number;
  /** The engine call of `importStaged` is running (set before it, cleared when its answer is recorded): found set on a restart, a call died inside the engine and what it added is not known (`marks.gap`). */
  importing?: boolean;
  /** Which lines the engine said it added, over every call of this merge: the ids (at most 1000 per call), how many it said, whether some are not named. The origin mark is put on these ids and no others. */
  marks?: { ids: string[]; count: number; truncated: boolean; gap: boolean };
}
/** `rejected*`: the masked ids of the lines the home refused, sent with `leftover/merged`; the ids are dropped once reported (the count stays: a re-lock of the same pack reports it again without ids). Absent = an entry from before this field (nothing is said). */
export interface LeftoverDone { kid: string; packId: string; sha256: string; at: number; conversations: number; memoryLines: number; /** Audit 61 (desktop 7): a call died inside the engine; how many lines came in is NOT known (`memoryLines` is then only what the engine's answers counted). The screen gets no number. */ memoryLinesUnknown?: true; reported: boolean; rejected?: number; rejectedIds?: string[]; rejectedIdsTruncated?: boolean }
export interface LeftoverOk { kid: string; sha256: string }
export interface OriginDoc {
  kid: string; lines: string[]; at: number;
  /** Personal lines this merge added that could not be marked because the engine's list of added ids was cut: "forget everything from this computer" cannot find them and says how many. */
  unmarked?: number;
  /** An engine call died inside the merge and what it added is not known: the same answer ("not all can be found"). */
  gap?: boolean;
}

/** Leftover's own ports (real: home-move-real.ts; a gate passes its own). */
export interface LeftoverDeps {
  /** Marks lines that have no evidence yet (evidence `[]`) with `marker`; returns how many were marked. Never touches a line that has evidence. The ids are the ones the engine said it added. */
  tagMemory(ids: string[], marker: string): number;
  lineIdsPresent(ids: string[]): string[];
  origins: { write(userId: string, doc: OriginDoc): boolean; read(userId: string, kid: string): OriginDoc | null; remove(userId: string, kid: string): void; list(userId: string): string[] };
  /** The ids of the live Personal lines whose evidence still carries a mark that starts with `markerPrefix` (an edited line is a new line without the mark, a forgotten one is empty: neither is listed). Only lines, never words. */
  markedMemoryIds(markerPrefix: string): string[];
  /** Audit 61 (desktop 6): the replaced (older) versions of a marked line that still carry the mark: the other computer's original wording after an owner edit. Absent = none are looked for. */
  markedOlderIds?(markerPrefix: string): string[];
  deleteLines(ids: string[]): number;
  /** The home's long-lived leftover box seed (a host-only file beside the device key, not in `one-move/`). */
  boxSecret: { read(userId: string): Buffer | null; write(userId: string, seed: Buffer): boolean; remove(userId: string): void;
    writeKrej(userId: string, sha256: string, key: Buffer): boolean; readKrej(userId: string, sha256: string): Buffer | null; removeKrej(userId: string, sha256?: string, exceptSha?: string): void };
}

export interface LeftoverCtx {
  now(): number;
  account(): Session | null;
  pointer(): PointerLike | null;
  keyed(userId: string): (HomeRecordView & { privateKey: string; pub: string; kid: string }) | null;
  load(userId: string): HomeRecordView | null;
  save(userId: string, record: HomeRecordView): void;
  call(route: string, mode: "host" | "kid", fields: Record<string, unknown>, session: Session, record: { hostId: string; privateKey: string; kid: string }): Promise<CallOut>;
  putLeftover(session: Session, record: { hostId: string; privateKey: string; kid: string }, fields: { sealedToPub: string; sealedToBox: string; sha256: string; bytes: number }, body: Buffer): Promise<CallOut>;
  getLeftover(session: Session, record: { hostId: string; privateKey: string }, kid: string, sha256: string, maxBytes: number): Promise<{ ok: true; bytes: Buffer } | { ok: false; code: string; unreachable?: boolean }>;
  readPointer(): Promise<boolean>;
  writesOpen(): boolean;
  confirm: ConfirmGate;
  /** The signed text of this deployment for a route (home.ts owns the primitive), the Ed25519 check, and the key id of a public key. */
  signedText(route: string, userId: string, body: Record<string, unknown>): string;
  verify(pub: string, text: string, sig: string): boolean;
  kidOf(pub: string): string;
  deps: MoveDeps;
}

const MIB = 1024 * 1024;
const SEND_NAMES = ["memory.sqlite", "conversation.jsonl", "context-seed.json", "profile.json", "avatar.bin", "manifest.json"] as const;
const FORBIDDEN_IN_PACK = ["checkins.jsonl", "settings.json", "reconnect.json"] as const;
const KID_RE = /^[A-Za-z0-9_-]{22}$/;
/** The folder a downloaded old record is opened in, under the staging base: `leftover-<kid>`, and only for a `kid` of the server's shape that resolves directly under the base (desktop C item 3; the move's `moveFolderOf` is the same rule). */
export function leftoverFolderOf(stagingBase: string, kid: string): string {
  const base = path.resolve(stagingBase); const own = path.resolve(base, `leftover-${String(kid)}`);
  if (!KID_RE.test(String(kid)) || path.dirname(own) !== base) throw new Error("kid_invalid");
  return own;
}
const PUB_RE = /^[A-Za-z0-9_-]{43}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const LIST_GAP_MS = 30_000;
const RESEND_AFTER_MS = 6 * 24 * 60 * 60_000;
/** A "merged" line of the pointer lives 30 days (contract one-home-leftover.md §4). A record that is still without proof this long after it was packed is not sent again: nothing is deleted, the answer is "merge not known". */
const MERGED_LINE_KEEP_MS = 30 * 24 * 60 * 60_000;
/** The ids of one engine purge call of "forget everything from this computer" (the engine deletes them in batches of 400 in one transaction each; a call that dies loses at most this many). */
const FORGET_SLICE = 1_000;
const CHAT_DELETE_SLICE = 2_000;
const yieldNow = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
const sha256Of = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const markerOf = (kid: string, sha: string): string => `origin:leftover:${kid}:${sha.slice(0, 16)}`;
export const originPrefixOf = (kid: string): string => `origin:leftover:${kid}:`;

export function createHomeLeftover(ctx: LeftoverCtx) {
  let driving: Promise<void> | null = null;
  let rerun = false;
  const crash = (point: string): void => ctx.deps.crash?.(point);
  const L = (): LeftoverDeps => { const l = ctx.deps.leftover; if (!l) throw new Error("leftover_unavailable"); return l; };
  // Memory only: dropped with the process. Codes the screen turns into sentences; never text from a bundle or from the server.
  const waiting = new Map<string, string>();
  /** "Forget everything from this computer" in progress (memory only; one at a time per account). */
  const forgetting = new Map<string, { kid: string; done: number; total: number }>();
  const requests = new Map<string, Array<{ kid: string; sha256: string; bytes: number; at: string; label: string | null }>>();
  const resent = new Set<string>();
  const lastListAt = new Map<string, number>();
  /** A server that answered 404 to a leftover route has none: no further leftover call this run (one pointer read must not become a stream of failing writes). */
  const noRoutes = new Set<string>();

  const cur = (): { session: Session; userId: string; record: HomeRecordView; key: NonNullable<ReturnType<LeftoverCtx["keyed"]>> } | null => {
    const session = ctx.account(); if (!session) return null;
    const key = ctx.keyed(session.userId); if (!key) return null;
    return { session, userId: session.userId, record: ctx.load(session.userId) ?? key, key };
  };
  const note = (userId: string, code: string | null): void => { if (code) waiting.set(userId, code); else waiting.delete(userId); };
  const patch = (userId: string, fields: Partial<HomeRecordView>): HomeRecordView => {
    const record = ctx.load(userId)!; const next = { ...record, ...fields } as HomeRecordView;
    for (const k of Object.keys(fields) as Array<keyof HomeRecordView>) if (fields[k] === undefined) delete next[k];
    ctx.save(userId, next); return next;
  };
  const lo = (r: HomeRecordView): LeftoverRec | null => { const v = rec(r.leftover); return v && typeof v.state === "string" ? v as unknown as LeftoverRec : null; };
  /** Leftover keeps its own sub-folders (`work/leftover`, `staging/leftover`): the move's sweeps and pack/stage clean-ups look at the top level only and never meet them. */
  const dirsOf = (userId: string): { workDir: string; stagingBase: string } => {
    const d = ctx.deps.dirs(userId);
    return { workDir: path.join(d.workDir, "leftover"), stagingBase: path.join(d.stagingBase, "leftover") };
  };
  /** The sub-folders exist only while there is something in them: an empty one is removed (no file or folder is left behind by a finished pass). */
  const tidy = (userId: string): void => { const d = dirsOf(userId); for (const dir of [d.workDir, d.stagingBase]) { try { fs.rmdirSync(dir); } catch { /* not empty or not there */ } } };
  const seenHome = (r: HomeRecordView, p: PointerLike): boolean => p.home.kind === "desktop" && !!p.pub && (r.seenHomes ?? []).some((h) => h.hostId === (p.home as { hostId: string }).hostId && h.pub === p.pub);
  const trusted = (r: HomeRecordView, p: PointerLike): boolean => p.homeTrust === "confirmed" && seenHome(r, p);

  /** The box key the pointer shows, only if it is the one the CURRENT home published: shape, host, key and epoch match and `boxSig` verifies with the home's key. Anything else: no upload. */
  function validBox(userId: string, p: PointerLike): { boxPub: string; epoch: number } | null {
    const b = rec(p.leftoverBox);
    if (!b || p.home.kind !== "desktop" || !p.pub) return null;
    if (b.hostId !== p.home.hostId || b.pub !== p.pub || b.epoch !== p.epoch || typeof b.boxPub !== "string" || typeof b.boxSig !== "string" || !PUB_RE.test(b.boxPub)) return null;
    return verifyLeftoverBoxSig(p.pub, userId, p.home.hostId, p.epoch, b.boxPub, b.boxSig) ? { boxPub: b.boxPub, epoch: p.epoch } : null;
  }

  // ───────────────────────── the pass ─────────────────────────
  /** One pass for the signed-in account. Single flight: a signal that arrives during a pass makes one more pass after it. */
  function drive(): Promise<void> {
    if (driving) { rerun = true; return driving; }
    driving = (async () => { try { do { rerun = false; await pass(); } while (rerun); } finally { driving = null; const a = ctx.account(); if (a) tidy(a.userId); } })();
    return driving;
  }
  async function pass(): Promise<void> {
    const c = cur(); if (!c) return;
    const pointer = ctx.pointer(); if (!pointer || !ctx.writesOpen()) return;   // switch not open: nothing is signed, packed, sent or merged
    if (noRoutes.has(c.userId)) return;
    if (c.record.state === "away") { await senderPass(c, pointer); return; }
    if (lo(c.record)) dropSender(c.userId);                                      // no longer away: the pack folder (a copy of the text) goes
    if (c.record.state === "home") await receiverPass(c, pointer);
  }

  // ───────────────────────── sender ─────────────────────────
  function dropSender(userId: string): void {
    const r = ctx.load(userId); const l = r ? lo(r) : null;
    if (!r || !l) return;
    if (l.packDir) discardPacked(l.packDir);
    L().boxSecret.removeKrej(userId);
    const { leftover: _l, ...rest } = r;
    ctx.save(userId, rest as HomeRecordView); note(userId, null); resent.delete(userId);
  }

  async function senderPass(c: NonNullable<ReturnType<typeof cur>>, pointer: PointerLike): Promise<void> {
    const { userId, key } = c;
    let l = lo(c.record);
    if (l?.state === "merged" || l?.state === "empty") { note(userId, null); return; }
    if (pointer.home.kind !== "desktop") { note(userId, "home_is_server"); return; }          // a server home: nothing is packed, sent or merged
    if (pointer.home.hostId === key.hostId) return;
    if (!trusted(c.record, pointer)) { note(userId, pointer.homeTrust === "unconfirmed" ? "ask_unconfirmed" : "ask_unseen"); return; }   // never sent, never deleted: a value asks once
    const box = validBox(userId, pointer);
    if (!box) { note(userId, "box_missing"); return; }
    if (!l) { l = await packNow(c, pointer); if (!l || l.state === "empty") return; }
    if (l.state === "packed") {
      // Repair 5 (web W-5): a record the server could not take for its account total waits for the home to merge (or a day), with its code; it is not sent again at every signal.
      if (l.full) {
        if (mergedSig(pointer) === l.full.sig && ctx.now() - l.full.at < FULL_RETRY_MS) { note(userId, "waiting_home_merge"); return; }
        const { full: _full, ...free } = l; patch(userId, { leftover: free as LeftoverRec }); l = free as LeftoverRec;
      }
      await sealAndUpload(c, pointer, box, l); return;
    }
    if (l.state === "uploaded") {
      const lines = Array.isArray(pointer.leftoverMerged) ? pointer.leftoverMerged : [];
      const proof = lines.find((m) => rec(m)?.kid === key.kid && rec(m)?.sha256 === l!.sha256);
      if (proof) { await finishSender(c, pointer, l, rec(proof)!); return; }
      if (ctx.now() - l.at > MERGED_LINE_KEEP_MS) {
        // The line that would prove the merge lives 30 days: after that a re-upload of the same bytes is ignored by the home (it merged them already) and no new line comes. Nothing is deleted; the answer is "merge not known".
        if (l.packDir) discardPacked(l.packDir);
        L().boxSecret.removeKrej(userId, l.sha256);
        ctx.save(userId, { ...ctx.load(userId)!, leftover: { ...l, state: "merged", packDir: undefined, purgeIds: undefined, code: "merge_unknown_kept" } as LeftoverRec });
        note(userId, null); return;
      }
      const stale = l.sealedToPub !== pointer.pub || l.sealedToBox !== box.boxPub;
      const old = !l.uploadedAt || ctx.now() - l.uploadedAt > RESEND_AFTER_MS;
      if (stale || old || !resent.has(userId)) { resent.add(userId); await sealAndUpload(c, pointer, box, l); }
      else note(userId, "waiting_home");
    }
  }

  /** The sender's host: the conversation text and the Personal lines; never check-ins, settings or reconnect names; the profile and the face only for the home that was taken over. */
  function sendHost(userId: string, former: boolean): BundleHost {
    const host = ctx.deps.bundleHost(userId);
    return { db: host.db, oneId: host.oneId, ...(former && host.profile ? { profile: host.profile } : {}), ...(former && host.avatar ? { avatar: host.avatar } : {}) };
  }

  async function packNow(c: NonNullable<ReturnType<typeof cur>>, pointer: PointerLike): Promise<LeftoverRec | null> {
    const { userId, key } = c;
    const { workDir } = dirsOf(userId);
    // A pack folder the record does not know (a run that died between packing and writing the record): removed. `discardPacked` removes only a folder whose owner marker proves it is ours.
    try { for (const name of fs.readdirSync(workDir)) if (name.startsWith("one-pack-")) discardPacked(path.join(workDir, name)); } catch { /* no folder yet */ }
    const last = rec(pointer.last);
    const former = last?.mode === "takeover" && rec(last.from)?.hostId === key.hostId;
    // The old-record road carries no forget stamp: what this computer forgot while it was not the home is not the owner's word on the home's lines.
    const packed = await packOne(sendHost(userId, former), { workDir, caller: ctx.deps.caller(), noStamps: true });
    if (packed.state !== "packed" || !packed.dir || !packed.manifest) { note(userId, packed.code === "engine_too_old" ? "engine_too_old" : "pack_failed"); return null; }   // an engine that does not know the road: nothing is packed or sent; the code waits for an engine update
    crash("leftover:packed:after-pack");
    const m = packed.manifest;
    const home = pointer.home as { hostId: string };
    const base = { at: ctx.now(), former, homeHostId: home.hostId, homePub: pointer.pub ?? "" };
    if (m.counts.messages === 0 && m.counts.memoryRows === 0) {
      discardPacked(packed.dir);
      patch(userId, { leftover: { ...base, state: "empty" } satisfies LeftoverRec });
      return lo(ctx.load(userId)!);
    }
    let ids: string[] = [];
    try { const parsed = JSON.parse(fs.readFileSync(path.join(packed.dir, "purge-ids.json"), "utf8")) as unknown; if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === "string"); } catch { ids = []; }
    const counts = { packedMessages: m.counts.messages, packedMemoryRows: m.counts.memoryRows, notPacked: packed.notPacked?.count ?? 0, droppedMessages: m.droppedMessages };
    patch(userId, { leftover: { ...base, state: "packed", packDir: packed.dir, packId: packed.packId, counts, ...(JSON.stringify(ids).length <= 2 * MIB ? { purgeIds: ids } : {}) } satisfies LeftoverRec });
    return lo(ctx.load(userId)!);
  }

  async function sealAndUpload(c: NonNullable<ReturnType<typeof cur>>, pointer: PointerLike, box: { boxPub: string }, l: LeftoverRec, attempt = 0): Promise<void> {
    const { userId, session, key } = c;
    const dir = l.packDir;
    if (!dir || !fs.existsSync(path.join(dir, "manifest.json"))) { patch(userId, { leftover: undefined }); note(userId, "pack_missing"); return; }   // packed again next pass; nothing was deleted
    for (const name of FORBIDDEN_IN_PACK) if (fs.existsSync(path.join(dir, name))) { note(userId, "pack_has_forbidden_file"); return; }
    const sealedPath = path.join(dir, "sealed.bin");
    let bytes: Buffer | null = null;
    if (l.sealedToPub === pointer.pub && l.sealedToBox === box.boxPub && l.sha256 && L().boxSecret.readKrej(userId, l.sha256) && fs.existsSync(sealedPath)) { const b = fs.readFileSync(sealedPath); if (sha256Of(b) === l.sha256) bytes = b; }
    let next = l;
    if (!bytes) {
      const files = SEND_NAMES.filter((n) => fs.existsSync(path.join(dir, n))).map((name) => ({ name, bytes: fs.readFileSync(path.join(dir, name)) }));
      let sealed: ReturnType<typeof sealLeftover>;
      try { sealed = sealLeftover(files, { userId, homePub: pointer.pub!, boxPub: box.boxPub, senderPub: key.pub }); } catch { note(userId, "seal_failed"); return; }
      if ("invalid" in sealed) { note(userId, sealed.invalid); return; }          // a zero key and the like: nothing is uploaded
      if (sealed.bytes.length > BUNDLE_WIRE_MAX) { note(userId, "bundle_too_large"); return; }
      // K_rejL under the record's own sha-256 BEFORE the bytes can leave (security follow-up): a record that is on the server always has its key here, and another record's key is never overwritten.
      if (!L().boxSecret.writeKrej(userId, sealed.sha256, sealed.krejL)) { note(userId, "key_storage_unavailable"); return; }
      L().boxSecret.removeKrej(userId, undefined, sealed.sha256);
      const tmp = `${sealedPath}.${randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, sealed.bytes, { mode: 0o600 }); fs.renameSync(tmp, sealedPath);
      bytes = sealed.bytes;
      next = { ...l, sha256: sealed.sha256, bytes: sealed.bytes.length, sealedToPub: pointer.pub!, sealedToBox: box.boxPub };
      patch(userId, { leftover: next });          // the record first, the upload next: a kill between them finds the same bytes
      crash("leftover:sealed:after-record");
    }
    const put = await ctx.putLeftover(session, key, { sealedToPub: next.sealedToPub!, sealedToBox: next.sealedToBox!, sha256: next.sha256!, bytes: bytes.length }, bytes);
    if (put.ok) {
      crash("leftover:uploaded:after-put");
      patch(userId, { leftover: { ...next, state: "uploaded", uploadedAt: ctx.now() } satisfies LeftoverRec });
      resent.add(userId);      // sent in this run: the next start (a new instance) sends the same bytes again if the proof has not been seen by then
      note(userId, "waiting_home"); return;
    }
    if (put.code === "sealed_to_stale" && attempt < 2) {
      // The home's key or box changed while this was being made: the answer carries the new pointer. Lock again to the new keys (nothing was deleted, nothing is lost).
      patch(userId, { leftover: { ...next, sealedToPub: undefined, sealedToBox: undefined, sha256: undefined, bytes: undefined } });
      try { fs.rmSync(sealedPath, { force: true }); } catch { /* replaced below */ }
      const p2 = ctx.pointer(); const b2 = p2 ? validBox(userId, p2) : null;
      if (p2 && b2) { const again = lo(ctx.load(userId)!); if (again) await sealAndUpload(c, p2, b2, again, attempt + 1); return; }
      note(userId, "box_missing"); return;
    }
    if (put.code === "leftover_bytes_full") {
      const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
      patch(userId, { leftover: { ...next, full: { at: ctx.now(), sig: mergedSig(pointer), ...(n(put.body?.heldBytes) !== undefined ? { heldBytes: n(put.body?.heldBytes) } : {}), ...(n(put.body?.limitBytes) !== undefined ? { limitBytes: n(put.body?.limitBytes) } : {}) } } satisfies LeftoverRec });
      note(userId, "waiting_home_merge"); return;
    }
    // Repair 5 (web W-8): `conflict` = two uploads of the account overlapped and this one was not stored: the SAME bytes again, at most twice in a row.
    if (put.code === "conflict" && attempt < 2) { await sealAndUpload(c, pointer, box, next, attempt + 1); return; }
    if (put.status === 404) noRoutes.add(userId);
    note(userId, put.unreachable ? "server_unreachable" : put.code === "device_not_trusted" ? "cannot_send_yet" : put.code);
  }

  /** The home signed the "merged" line (contract one-home-leftover.md §6, revision 11-12k): the signed body is rebuilt from the line and `proof.sent`, and checked with the key THIS computer holds for `proof.hostId` in its own
   * `seenHomes` (local evidence, never a key the pointer shows). No `proof` (an older server), a home this computer has not seen, or a signature that does not hold: false. */
  function mergedProofHolds(c: NonNullable<ReturnType<typeof cur>>, line: Record<string, unknown>): boolean {
    const proof = rec(line.proof);
    if (!proof || typeof proof.hostId !== "string" || typeof proof.nonce !== "string" || typeof proof.sig !== "string" || !Number.isSafeInteger(proof.ts) || !Array.isArray(proof.sent)) return false;
    const seen = (c.record.seenHomes ?? []).find((h) => h.hostId === proof.hostId);
    if (!seen || !PUB_RE.test(seen.pub)) return false;
    if (typeof line.kid !== "string" || typeof line.sha256 !== "string") return false;
    const body: Record<string, unknown> = { hostId: proof.hostId, ts: proof.ts, nonce: proof.nonce, kid: line.kid, sha256: line.sha256, conversations: line.conversations, memoryLines: line.memoryLines };
    for (const name of proof.sent) {
      if (name === "rejected") body.rejected = line.rejected;
      else if (name === "rejectedIds") body.rejectedIds = line.rejectedIds;
      else if (name === "rejectedIdsTruncated") body.rejectedIdsTruncated = line.rejectedIdsTruncated === true;
      else return false;
    }
    // A field the line carries that the signature does not cover would be unsigned: it is not trusted either.
    for (const [name, field] of [["rejected", line.rejected], ["rejectedIds", line.rejectedIds]] as const) if (field !== undefined && !proof.sent.includes(name)) return false;
    if (line.rejectedIdsTruncated !== undefined && !proof.sent.includes("rejectedIdsTruncated")) return false;
    try { return ctx.verify(seen.pub, ctx.signedText("leftover/merged", c.userId, body), proof.sig); } catch { return false; }
  }

  /** Proof (`leftoverMerged`: my kid, the sha-256 I uploaded) AND trust (confirmed + seen): only then the lines go and the conversation stays as "conversation before the move". */
  async function finishSender(c: NonNullable<ReturnType<typeof cur>>, pointer: PointerLike, l: LeftoverRec, proof: Record<string, unknown>): Promise<void> {
    const { userId } = c;
    if (!trusted(c.record, pointer)) { note(userId, "merged_not_trusted"); return; }
    if (!mergedProofHolds(c, proof)) { note(userId, "merged_not_trusted"); return; }   // F-13: a line anyone could have written into the pointer document deletes nothing
    const dir = l.packDir;
    let purged: { purged: number; kept: number; alreadyGone: number; skipped: number } | null = null;
    // Security follow-up: the home's answer must account for every line it refused. `rejected` = 0 (with an empty list) is the only answer that lets everything go without a mask;
    // otherwise the masked ids (K_rejL of THIS record) must match exactly `rejected` of the ids packed. A missing field (an older server), a truncated list, a count that does not add up, or a lost key: nothing is deleted.
    const said = typeof proof.rejected === "number" && Number.isSafeInteger(proof.rejected) && proof.rejected >= 0 ? proof.rejected : null;
    const maskedList = Array.isArray(proof.rejectedIds) ? proof.rejectedIds.filter((x): x is string => typeof x === "string") : [];
    const truncated = proof.rejectedIdsTruncated === true;
    let keepIds: string[] = [];
    let accounted = said === 0 && maskedList.length === 0 && !truncated;
    if (!accounted && said !== null && !truncated && said === maskedList.length) {
      const krejL = L().boxSecret.readKrej(userId, l.sha256 ?? "");
      let ids = l.purgeIds ?? [];
      if (!ids.length && dir) { try { const parsed = JSON.parse(fs.readFileSync(path.join(dir, "purge-ids.json"), "utf8")) as unknown; if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === "string"); } catch { /* no list */ } }
      if (krejL) { const set = new Set(maskedList); keepIds = [...new Set(ids)].filter((id) => set.has(maskId(krejL, id))); accounted = keepIds.length === said; }
    }
    if (!accounted) {
      if (dir) discardPacked(dir);              // a copy of the text goes; the lines and the conversation stay on this computer as they are
      L().boxSecret.removeKrej(userId, l.sha256);
      const fresh0 = ctx.load(userId)!;
      ctx.save(userId, { ...fresh0, leftover: { ...l, state: "merged", packDir: undefined, purgeIds: undefined, code: "rejected_ids_incomplete" } as LeftoverRec });
      note(userId, null); return;
    }
    if (dir && fs.existsSync(dir)) {
      const out = await purgePacked(dir, { caller: ctx.deps.caller(), retryPauseMs: ctx.deps.pauseMs ?? 1000, keepIds, expectedKept: said ?? 0 });
      if (out.state === "failed" || out.state === "refused") { note(userId, out.code ?? "purge_failed"); return; }
      if (out.state !== "purged") { note(userId, out.code ?? "purge_remaining"); return; }
      purged = { purged: out.purged ?? 0, kept: out.kept ?? 0, alreadyGone: out.alreadyGone ?? 0, skipped: out.skippedTotal ?? 0 };
    }
    L().boxSecret.removeKrej(userId, l.sha256);
    crash("leftover:purged:after-purge");
    const host = ctx.deps.bundleHost(userId);
    const chat = boundPersonalChat(host.db, host.oneId);
    ctx.deps.unbindPersonalChat();         // the conversation is not deleted line by line: it is only no longer the personal conversation ("before the move")
    const counts = { ...(l.counts ?? {}), ...(purged ? { purged: purged.purged, purgeKept: purged.kept, alreadyGone: purged.alreadyGone, purgeSkipped: purged.skipped } : {}), mergedConversations: Number(proof.conversations) || 0, mergedMemoryLines: Number(proof.memoryLines) || 0 };
    const fresh = ctx.load(userId)!;
    ctx.save(userId, { ...fresh, ...(chat ? { beforeMove: { chatId: chat, at: ctx.now() } } : {}), leftover: { ...l, state: "merged", packDir: undefined, purgeIds: undefined, counts } as LeftoverRec });
    note(userId, null);
  }

  /** [send] (the owner's answer to the one question about an unconfirmed or never-seen home). The owner window asks; the yes runs from the confirmation window. */
  function requestSend(): { ok: boolean; code?: string; requestId?: string } {
    const c = cur(); if (!c) return { ok: false, code: "sign_in_required" };
    if (!ctx.writesOpen()) return { ok: false, code: "device_proof_unavailable" };
    const pointer = ctx.pointer();
    if (c.record.state !== "away" || !pointer || pointer.home.kind !== "desktop" || !pointer.pub) return { ok: false, code: "no_question" };
    if (trusted(c.record, pointer)) return { ok: false, code: "no_question" };
    const seen = { hostId: pointer.home.hostId, pub: pointer.pub, epoch: pointer.epoch, unconfirmed: pointer.homeTrust === "unconfirmed" };
    return ctx.confirm.request("sendLeftover", { label: typeof pointer.home.label === "string" ? pointer.home.label : null, unconfirmed: seen.unconfirmed }, async () => {
      const now = cur(); const p = ctx.pointer();
      if (!now || !p || p.home.kind !== "desktop" || p.home.hostId !== seen.hostId || p.pub !== seen.pub || p.epoch !== seen.epoch) return { ok: false, code: "request_changed" };   // the home changed after the owner looked
      if (p.homeTrust === "unconfirmed") {
        const out = await ctx.call("confirm", "kid", {}, now.session, now.key);   // "it was me": the confirmation signature
        if (!out.ok) return { ok: false, code: out.unreachable ? "server_unreachable" : out.code };
        await ctx.readPointer();
      }
      const record = ctx.load(now.userId)!;
      const seenHomes = [...(record.seenHomes ?? []).filter((h) => h.hostId !== seen.hostId), { hostId: seen.hostId, pub: seen.pub }].slice(-8);
      ctx.save(now.userId, { ...record, seenHomes });
      void drive().catch(() => undefined);
      return { ok: true };
    });
  }

  // ───────────────────────── receiver ─────────────────────────
  async function receiverPass(c: NonNullable<ReturnType<typeof cur>>, pointer: PointerLike): Promise<void> {
    const { userId, session, key } = c;
    const mine = pointer.home.kind === "desktop" && pointer.home.hostId === key.hostId && pointer.pub === key.pub;
    if (!mine || pointer.homeTrust === "unconfirmed") return;     // never merge into a home that waited its way in and was not confirmed
    if (!(await ensureBox(c, pointer))) return;
    const after = ctx.pointer() ?? pointer;
    await reportPending(c);
    const t = ctx.now();
    if (lastListAt.get(userId) !== undefined && t - lastListAt.get(userId)! < LIST_GAP_MS && !rec(ctx.load(userId)?.leftoverWork)) return;
    lastListAt.set(userId, t);
    const out = await ctx.call("leftover/list", "host", {}, session, key);
    if (!out.ok) { note(userId, out.unreachable ? "server_unreachable" : out.code); return; }
    const items = readLeftoverListItems(out.body.items, BUNDLE_WIRE_MAX);   // kid, sha256, hostId, bytes, at, proof: each in its shape, an item that does not hold is dropped whole (desktop C item 3)
    // A merge that was in progress finishes first (one at a time); one whose item is gone from the server is dropped with its staged copy.
    const work = rec(ctx.load(userId)?.leftoverWork) as unknown as LeftoverWork | null;
    if (work && (typeof work.kid !== "string" || !KID_RE.test(work.kid) || typeof work.sha256 !== "string" || !SHA_RE.test(work.sha256))) dropWork(userId);   // a record whose work names no id (a damaged file): its staged copy goes (marker proven), nothing else is touched
    else if (work && !items.some((i) => i.kid === work.kid && i.sha256 === work.sha256)) {
      if (work.step === "staged") dropWork(userId);
      else await mergeOne(c, after, { kid: work.kid, sha256: work.sha256, hostId: work.hostId, bytes: 0 });   // imported already: only the mark, the record and the report are left
    }
    const pending: Array<{ kid: string; sha256: string; bytes: number; at: string; label: string | null }> = [];
    for (const item of items) {
      const kid = item.kid as string, sha = item.sha256 as string;
      const done = doneList(ctx.load(userId)!).find((e) => e.kid === kid && e.sha256 === sha);
      if (done) { await reportPending(c); continue; }
      const verdict = senderOf(c, after, item);
      if (verdict.verdict === "reject") { note(userId, verdict.code); continue; }
      const approved = okList(ctx.load(userId)!).some((o) => o.kid === kid && o.sha256 === sha);
      if (verdict.verdict !== "known" && !approved) { pending.push({ kid, sha256: sha, bytes: item.bytes as number, at: typeof item.at === "string" ? item.at : "", label: labelOf(after, kid) }); continue; }   // not downloaded: a request for the owner
      const w = rec(ctx.load(userId)?.leftoverWork) as unknown as LeftoverWork | null;
      if (w && !(w.kid === kid && w.sha256 === sha)) continue;
      const ended = await mergeOne(c, after, item);
      if (ended === "stop") break;
    }
    requests.set(userId, pending);
  }

  const doneList = (r: HomeRecordView): LeftoverDone[] => (Array.isArray(r.leftoverDone) ? r.leftoverDone as LeftoverDone[] : []);
  const okList = (r: HomeRecordView): LeftoverOk[] => (Array.isArray(r.leftoverOk) ? r.leftoverOk as LeftoverOk[] : []);
  const labelOf = (p: PointerLike, kid: string): string | null => {
    const lists = [p.devices, p.pendingDevices].flatMap((v) => (Array.isArray(v) ? v : []));
    const line = lists.map(rec).find((d) => d?.kid === kid);
    return typeof line?.label === "string" ? line.label.slice(0, 64) : null;
  };

  /**
   * Who made this record, from the proof the server kept (the sender's own signature over the upload; contract §1.5 + "home-side rules"). Nothing is downloaded before this says `known` or `unknown`.
   * `known` = ONLY a key this computer has in its own `seenHomes` (written by an owner action or a verified move; see the list in home.ts runStartHere). The pointer's `trust` mark and a home that was pushed out
   * by a takeover are NOT a known sender (a server field can be rewritten by whoever gains write access; a takeover is consent to become the home, not to vouch for the old one): they go to the owner's [merge].
   * The signed text is rebuilt with THIS computer's own values for what it was sealed to (its key and its published box key), not the pointer's.
   */
  function senderOf(c: NonNullable<ReturnType<typeof cur>>, pointer: PointerLike, item: Record<string, unknown>): { verdict: "known" | "unknown" } | { verdict: "reject"; code: string } {
    const proof = rec(item.proof);
    if (!proof) return { verdict: "reject", code: "sender_proof_missing" };
    if (typeof proof.pub !== "string" || !PUB_RE.test(proof.pub) || typeof proof.sig !== "string" || typeof proof.nonce !== "string" || !Number.isSafeInteger(proof.ts)) return { verdict: "reject", code: "sender_proof_invalid" };
    if (ctx.kidOf(proof.pub) !== item.kid) return { verdict: "reject", code: "sender_proof_invalid" };
    const seen = (c.record.seenHomes ?? []).find((h) => ctx.kidOf(h.pub) === item.kid);          // local evidence first: a computer this one has a record of (its key, not a name it claims)
    if (seen && seen.pub !== proof.pub) return { verdict: "reject", code: "sender_proof_invalid" };
    if (!seen && !(Array.isArray(pointer.devices) ? pointer.devices : []).map(rec).some((d) => !!d && d.kid === item.kid)) return { verdict: "reject", code: "sender_key_unknown" };   // the key must at least be a registered one
    const seed = L().boxSecret.read(c.userId);
    if (!seed) return { verdict: "reject", code: "box_key_lost" };
    const body = { kid: item.kid, ts: proof.ts, nonce: proof.nonce, hostId: item.hostId, sealedToPub: c.key.pub, sealedToBox: boxPubFromSeed(seed), sha256: item.sha256, bytes: item.bytes };
    if (!ctx.verify(proof.pub, ctx.signedText("leftover", c.userId, body), proof.sig)) return { verdict: "reject", code: "sender_proof_invalid" };
    return { verdict: seen ? "known" : "unknown" };
  }

  async function ensureBox(c: NonNullable<ReturnType<typeof cur>>, pointer: PointerLike): Promise<boolean> {
    const { userId, session, key } = c;
    const lb = rec(c.record.leftoverBox) as unknown as LeftoverBoxRec | null;
    const shown = validBox(userId, pointer);
    let seed = L().boxSecret.read(userId);
    if (shown && lb && seed && lb.boxPub === shown.boxPub && boxPubFromSeed(seed) === shown.boxPub) return true;
    if (!seed || !lb || lb.epoch !== pointer.epoch || lb.pub !== pointer.pub) {
      seed = generateBoxKeyPair().secret;
      if (!L().boxSecret.write(userId, seed)) { note(userId, "key_storage_unavailable"); return false; }
      patch(userId, { leftoverBox: { boxPub: boxPubFromSeed(seed), epoch: pointer.epoch, pub: key.pub } satisfies LeftoverBoxRec });
    }
    crash("leftover:box:after-seed");
    const boxPub = boxPubFromSeed(seed);
    const out = await ctx.call("leftover/box", "host", { epoch: pointer.epoch, boxPub, boxSig: signLeftoverBox(key.privateKey, userId, key.hostId, pointer.epoch, boxPub) }, session, key);
    if (!out.ok) { if (out.status === 404) noRoutes.add(userId); if (out.code === "stale_epoch") await ctx.readPointer(); note(userId, out.unreachable ? "server_unreachable" : out.code); return false; }
    return true;
  }

  function dropWork(userId: string): void {
    const r = ctx.load(userId); const w = r ? rec(r.leftoverWork) as unknown as LeftoverWork | null : null;
    if (w?.stagedDir) discardStaged(w.stagedDir);
    if (r) { const { leftoverWork: _w, ...rest } = r; ctx.save(userId, rest as HomeRecordView); }
  }

  const lineIdsOf = (dir: string): string[] => {
    try {
      return fs.readFileSync(path.join(dir, "conversation.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { const v = JSON.parse(l) as { id?: unknown; role?: unknown }; return typeof v.id === "string" && v.role !== "system" ? v.id : ""; } catch { return ""; } }).filter(Boolean);
    } catch { return []; }
  };

  async function mergeOne(c: NonNullable<ReturnType<typeof cur>>, pointer: PointerLike, item: Record<string, unknown>): Promise<"go" | "stop"> {
    const { userId, session, key } = c;
    const kid = item.kid as string, sha = item.sha256 as string;
    if (!KID_RE.test(kid) || !SHA_RE.test(sha)) return "go";      // a value that is not an id names no folder, no file and no key: nothing is read, written or deleted (also for a `work` read back from the record)
    let work = rec(ctx.load(userId)?.leftoverWork) as unknown as LeftoverWork | null;
    if (!work) {
      const got = await ctx.getLeftover(session, key, kid, sha, BUNDLE_WIRE_MAX);
      if (!got.ok) { if (got.code === "leftover_missing") return "go"; note(userId, got.unreachable ? "server_unreachable" : got.code); return "stop"; }
      if (got.bytes.length !== item.bytes || sha256Of(got.bytes) !== sha) { note(userId, "bundle_hash_mismatch"); return "go"; }   // dropped before it is opened; nobody reports merged
      const seed = L().boxSecret.read(userId); const lb = rec(ctx.load(userId)?.leftoverBox) as unknown as LeftoverBoxRec | null;
      const senderPub = (rec(item.proof)?.pub as string | undefined) ?? "";
      if (!seed || !lb || !pointer.pub) { note(userId, "box_key_lost"); return "stop"; }
      const opened = openLeftover(got.bytes, seed, { userId, homePub: pointer.pub, boxPub: lb.boxPub, senderPub });
      if ("invalid" in opened) { note(userId, opened.invalid); return "go"; }                       // `invalid` is never reported merged: the sender keeps everything
      if (!L().boxSecret.writeKrej(userId, sha, opened.krejL)) { note(userId, "key_storage_unavailable"); return "stop"; }   // before any plaintext is written
      crash("leftover:got:after-open");
      const { stagingBase } = dirsOf(userId);
      const download = leftoverFolderOf(stagingBase, kid);
      fs.rmSync(download, { recursive: true, force: true }); fs.mkdirSync(download, { recursive: true, mode: 0o700 });
      try { for (const f of opened.files) fs.writeFileSync(path.join(download, f.name), f.bytes, { mode: 0o600 }); const staged = stageBundle(download, { stagingBase });
        if (staged.state !== "staged" || !staged.dir) { note(userId, staged.code ?? "stage_failed"); return "go"; }
        const packId = staged.packId ?? "";
        const prior = doneList(ctx.load(userId)!).find((e) => e.kid === kid && e.packId === packId);
        if (prior) {          // the same pack again (a re-lock after the home's key changed): it is not merged twice
          discardStaged(staged.dir);
          pushDone(userId, { ...prior, sha256: sha, at: ctx.now(), reported: false, ...(prior.rejected !== undefined ? { rejected: prior.rejected, rejectedIds: [], rejectedIdsTruncated: prior.rejected > 0 } : {}) });   // masks of the first lock do not fit this one: more than zero refused = "cannot account", the sender keeps everything
          await reportPending(c); return "go";
        }
        const lineIds = lineIdsOf(staged.dir);
        work = { kid, sha256: sha, hostId: String(item.hostId), startedAt: ctx.now(), step: "staged", stagedDir: staged.dir, packId, preLines: L().lineIdsPresent(lineIds) };
        patch(userId, { leftoverWork: work });
      } finally { fs.rmSync(download, { recursive: true, force: true }); }
    }
    if (!work) return "go";
    if (work.step === "staged") {
      if (!work.stagedDir || !fs.existsSync(work.stagedDir)) { dropWork(userId); return "go"; }   // the plaintext is gone: fetch again (the server's copy is still there)
      // The old-record road takes no stamp: there is no "this would blank N of your lines" question any more, because nothing is blanked. An engine that does not know the road keeps the staged copy and waits.
      // This home is the receiver and the engine is called from its own engine home: `wouldStoreFull` is the number of lines this home has no room for (desktop C item 1).
      const check = await checkStaged(work.stagedDir, { caller: ctx.deps.caller(), noStamps: true, receiving: true });
      if (check.code === "engine_too_old") { note(userId, "engine_too_old"); return "stop"; }
      if (check.state !== "ok") { dropWork(userId); note(userId, check.code ?? "bundle_invalid"); return "go"; }
      if ((check.wouldStoreFull ?? 0) !== (work.wouldStoreFull ?? 0)) { work = { ...work, ...(check.wouldStoreFull ? { wouldStoreFull: check.wouldStoreFull } : { wouldStoreFull: undefined }) }; patch(userId, { leftoverWork: work }); }
      const sources: BundleSources = ctx.deps.sources();
      const full = ctx.deps.bundleHost(userId);
      const host: BundleHost = { ...full, plantContextSeed: undefined, checkins: undefined };   // a leftover plants no seed and merges no check-in
      const copy = stageBundle(work.stagedDir!, { stagingBase: dirsOf(userId).stagingBase });
      if (copy.state !== "staged" || !copy.dir) { note(userId, copy.code ?? "stage_failed"); return "stop"; }
      // A call that died inside the engine last time (the flag is still set) added lines whose ids nobody was told: they cannot be marked (`marks.gap`).
      const before = work.marks ?? { ids: [], count: 0, truncated: false, gap: false };
      const startMarks = work.importing ? { ...before, gap: true } : before;
      work = { ...work, importing: true, marks: startMarks }; patch(userId, { leftoverWork: work });
      const res = await importStaged(copy.dir, host, { caller: ctx.deps.caller(), retryPauseMs: ctx.deps.pauseMs ?? 1000, noStamps: true, engineRoots: ctx.deps.engineRoots() });
      if (res.state !== "imported") discardStaged(copy.dir);
      crash("leftover:staged:before-record");     // a kill here is the one window where lines were added and nobody wrote their ids down: the `importing` flag stays set and the next run knows
      // What the engine said it added, over every call of this merge: one list (a call that goes on after a break does not name what the call before it added). Written down before anything else happens.
      const got = res.inserted;
      const marks = { ids: [...new Set([...startMarks.ids, ...(got?.ids ?? [])])], count: startMarks.count + (got?.count ?? 0), truncated: startMarks.truncated || got?.truncated === true, gap: startMarks.gap || got?.gap === true };
      work = { ...work, importing: undefined, marks };
      patch(userId, { leftoverWork: work });
      crash("leftover:staged:after-import");
      if (res.state === "remaining" && res.code === "engine_too_old") { patch(userId, { leftoverWork: work }); note(userId, "engine_too_old"); return "stop"; }
      if (res.state === "refused") { patch(userId, { leftoverWork: work }); note(userId, res.code ?? "import_refused"); return "stop"; }
      if (res.state === "remaining" || res.state === "partial") { const attempts = (work.attempts ?? 0) + 1; work = { ...work, attempts }; patch(userId, { leftoverWork: work }); note(userId, attempts >= 5 ? "import_remaining_limit" : res.code ?? "import_remaining"); return "stop"; }
      if (res.state === "invalid") { dropWork(userId); note(userId, res.code ?? "bundle_invalid"); return "go"; }   // never reported merged
      // The name and the face come back only from the home that was taken over, and only where this computer has its own default; the text the owner wrote about themselves is never taken from an old
      // record, and a conflict is never asked here (the home's value stays).
      try { const handed = handedBackFrom(c, work.hostId, res.profile, res.avatar); if (handed) applyHandedBack(sources, handed); } catch { /* not applied */ }
      const mem = (res.memory ?? {}) as Record<string, unknown>;
      const krejL = L().boxSecret.readKrej(userId, sha);
      const refusedIds = (res.rejectedIds ?? []).slice(0, 200);
      const refusedCount = Number.isSafeInteger(res.rejected) ? (res.rejected as number) : 0;
      const maskedIds = krejL ? refusedIds.map((id) => maskId(krejL, id)) : [];
      work = { ...work, rejected: { count: refusedCount, ids: maskedIds, truncated: res.rejectedIdsTruncated === true || maskedIds.length < refusedCount }, step: "imported", counts: { conversations: res.conversation?.inserted ?? 0, memoryLines: Number(mem.inserted ?? 0), rejected: res.rejected ?? 0, alreadyThere: res.conversation?.alreadyThere ?? 0, droppedSystem: res.conversation?.droppedSystem ?? 0, droppedBadDate: res.conversation?.droppedBadDate ?? 0 } };
      patch(userId, { leftoverWork: work });
    }
    if (work.step === "imported") {
      // The origin mark: lines that this merge brought in (not the ones this computer had already) carry where they came from. Idempotent: a run that died here marks again.
      const marker = markerOf(kid, sha);
      const dir = work.stagedDir;
      const marks = work.marks ?? { ids: [], count: 0, truncated: false, gap: false };
      // The memory lines this merge added are the ids the ENGINE named, never the ids a bundle file happens to hold: a line the home had is not in the list, and no id shape decides anything.
      L().tagMemory(marks.ids, marker);
      const unmarked = marks.truncated ? Math.max(0, marks.count - marks.ids.length) : 0;
      let arrived: string[] = [];
      if (dir && fs.existsSync(dir)) {
        const preL = new Set(work.preLines ?? []);
        arrived = L().lineIdsPresent(lineIdsOf(dir).filter((id) => !preL.has(id)));
      }
      if (arrived.length || unmarked || marks.gap) {
        const prev = L().origins.read(userId, kid);
        L().origins.write(userId, { kid, lines: [...new Set([...(prev?.lines ?? []), ...arrived])], at: ctx.now(), ...(unmarked || prev?.unmarked ? { unmarked: (prev?.unmarked ?? 0) + unmarked } : {}), ...(marks.gap || prev?.gap ? { gap: true } : {}) });
      }
      crash("leftover:imported:after-mark");
      const counts = work.counts ?? {};
      const rj = work.rejected ?? { count: 0, ids: [], truncated: false };
      pushDone(userId, { kid, packId: work.packId ?? "", sha256: sha, at: ctx.now(), conversations: counts.conversations ?? 0, memoryLines: counts.memoryLines ?? 0, ...(marks.gap ? { memoryLinesUnknown: true as const } : {}), reported: false, rejected: rj.count, rejectedIds: rj.ids, rejectedIdsTruncated: rj.truncated });
      const r = ctx.load(userId)!;
      const { leftoverWork: _w, ...rest } = r;
      ctx.save(userId, { ...rest, leftoverOk: okList(r).filter((o) => !(o.kid === kid && o.sha256 === sha)) } as HomeRecordView);
      if (dir) discardStaged(dir);               // the staged original goes only now, after the record holds the result
      crash("leftover:merged:after-record");
      await reportPending(c);
    }
    return "go";
  }

  /** Audit 59 B2: what an old record may hand back of the sender's profile. Only when the pointer's last act is the TAKEOVER that made THIS computer the home from exactly that sender (its host id, and the epoch of this home), and then
   * only the name, the role and the face (the home's own value wins unless it is the default: `applyHandedBack`). The text the owner wrote about themselves, the language, the time zone and the colour are never taken from an old record. */
  function handedBackFrom(c: NonNullable<ReturnType<typeof cur>>, senderHostId: string, profile: Record<string, unknown> | null | undefined, avatar: Buffer | null | undefined): HandedBack | null {
    const pointer = ctx.pointer(); const last = rec(pointer?.last);
    if (!pointer || pointer.home.kind !== "desktop" || pointer.home.hostId !== c.key.hostId || pointer.pub !== c.key.pub) return null;
    if (last?.mode !== "takeover" || rec(last.from)?.hostId !== senderHostId || senderHostId === c.key.hostId) return null;
    if (ctx.load(c.userId)?.epoch !== pointer.epoch) return null;
    const closed: Record<string, unknown> = {};
    for (const k of ["displayName", "role", "avatarIcon"] as const) if (profile && profile[k] !== undefined) closed[k] = profile[k];
    return { profile: Object.keys(closed).length ? closed : null, avatar: avatar ?? null, settings: null };
  }

  function pushDone(userId: string, entry: LeftoverDone): void {
    const r = ctx.load(userId)!;
    const list = [...doneList(r).filter((e) => !(e.kid === entry.kid && e.sha256 === entry.sha256)), entry].slice(-16);
    ctx.save(userId, { ...r, leftoverDone: list });
  }

  /** `leftover/merged` for every merged record the server has not been told about (two numbers; no id, no text). `already` and `no_such_leftover` both end it. */
  async function reportPending(c: NonNullable<ReturnType<typeof cur>>): Promise<void> {
    const { userId, session, key } = c;
    for (const e of doneList(ctx.load(userId)!)) {
      if (e.reported) continue;
      const refused = e.rejected !== undefined ? { rejected: e.rejected, rejectedIds: e.rejectedIds ?? [], ...(e.rejectedIdsTruncated ? { rejectedIdsTruncated: true } : {}) } : {};   // an entry from before the field says nothing
      const out = await ctx.call("leftover/merged", "host", { kid: e.kid, sha256: e.sha256, conversations: e.conversations, memoryLines: e.memoryLines, ...refused }, session, key);
      if (out.ok || out.code === "no_such_leftover") {
        crash("leftover:merged:after-report");
        const r = ctx.load(userId)!;
        ctx.save(userId, { ...r, leftoverDone: doneList(r).map((x) => { if (!(x.kid === e.kid && x.sha256 === e.sha256)) return x; const { rejectedIds: _ids, ...keep } = x; return { ...keep, reported: true }; }) });
        L().boxSecret.removeKrej(userId, e.sha256);
      } else { note(userId, out.unreachable ? "server_unreachable" : out.code); return; }
    }
  }

  // ───────────────────────── owner presses ─────────────────────────
  /** [merge] on a request from a computer this home does not know: the yes (Main confirmation window) is the only thing that lets the record be downloaded. */
  function requestMerge(arg: { kid?: unknown }): { ok: boolean; code?: string; requestId?: string } {
    const c = cur(); if (!c) return { ok: false, code: "sign_in_required" };
    if (!ctx.writesOpen()) return { ok: false, code: "device_proof_unavailable" };
    if (typeof arg.kid !== "string" || !KID_RE.test(arg.kid)) return { ok: false, code: "invalid_args" };
    const ask = (requests.get(c.userId) ?? []).find((q) => q.kid === arg.kid);
    if (!ask) return { ok: false, code: "no_such_request" };
    const userId = c.userId;
    return ctx.confirm.request("mergeLeftover", { computer: ask.label, bytes: ask.bytes, at: ask.at }, async () => {
      const still = (requests.get(userId) ?? []).find((q) => q.kid === ask.kid && q.sha256 === ask.sha256);
      if (!still) return { ok: false, code: "request_changed" };               // replaced or gone after the owner looked: nothing is merged
      const r = ctx.load(userId); if (!r) return { ok: false, code: "sign_in_required" };
      ctx.save(userId, { ...r, leftoverOk: [...okList(r).filter((o) => !(o.kid === ask.kid && o.sha256 === ask.sha256)), { kid: ask.kid, sha256: ask.sha256 }].slice(-8) });
      lastListAt.delete(userId);
      void drive().catch(() => undefined);
      return { ok: true };
    });
  }
  /** "Forget everything that came from this computer". The lines are chosen by their origin mark ONLY (the ids the engine said it added, marked when they came in, and still carrying the mark: a line the owner edited is a new
   * line without it, a forgotten one is empty) and are deleted by exact id through the engine's id purge: no forget stamp is written (the home may learn the same words again), nothing is matched by words or kind, so a line of the
   * home's own, another agent's or project's line, or another computer's line with the same words is never a candidate. The conversation lines merged from it are deleted by exact id. It is asynchronous (the engine runs in its own
   * process, 1,000 ids per call): the screen reads `view().receiver.forgetting` ({ kid, done, total }) meanwhile. The index file loses the ids that went; it is deleted only when nothing is left and nothing could not be marked. */
  async function forgetFrom(arg: { kid?: unknown }): Promise<{ ok: boolean; code?: string; forgottenLines?: number; forgottenOlderVersions?: number; failedLines?: number; deletedMessages?: number; notIdentified?: number; markIncomplete?: boolean }> {
    const c = cur(); if (!c) return { ok: false, code: "sign_in_required" };
    if (typeof arg.kid !== "string" || !KID_RE.test(arg.kid)) return { ok: false, code: "invalid_args" };
    if (forgetting.has(c.userId)) return { ok: false, code: "forget_running" };
    const kid = arg.kid, userId = c.userId;
    const progress = { kid, done: 0, total: 0 };
    forgetting.set(userId, progress);
    try {
      reclaimStaleDirs(dirsOf(userId).workDir);       // an id folder of a forget that died (owner process gone) goes; marker proven
      const doc = L().origins.read(userId, kid);
      const liveIds = L().markedMemoryIds(originPrefixOf(kid));
      // The replaced versions of such a line (the owner edited it: the new line stays, it is the owner's own) go with them, by id, only when they carry the mark.
      const olderIds = (L().markedOlderIds?.(originPrefixOf(kid)) ?? []).filter((id) => !liveIds.includes(id));
      const ids = [...liveIds, ...olderIds];
      progress.total = ids.length + (doc?.lines.length ?? 0);
      for (let i = 0; i < ids.length; i += FORGET_SLICE) {
        const part = ids.slice(i, i + FORGET_SLICE);
        const out = await purgeIdList(part, { workDir: dirsOf(userId).workDir, caller: ctx.deps.caller(), retryPauseMs: ctx.deps.pauseMs ?? 1000 });
        void out;   // a slice that did not go is seen by the read below: its lines are still marked
        progress.done += part.length;
        await yieldNow();
      }
      const left = [...L().markedMemoryIds(originPrefixOf(kid)), ...(L().markedOlderIds?.(originPrefixOf(kid)) ?? [])];          // read again: what is still marked did not go (a version that stays is counted in `failedLines`, never hidden)
      const leftSet = new Set(left);
      const forgotten = liveIds.filter((id) => !leftSet.has(id)).length;
      const olderForgotten = olderIds.filter((id) => !leftSet.has(id)).length;
      let deleted = 0, messagesLeft: string[] = [];
      if (doc) {
        for (let i = 0; i < doc.lines.length; i += CHAT_DELETE_SLICE) {
          const part = doc.lines.slice(i, i + CHAT_DELETE_SLICE);
          try { deleted += L().deleteLines(part); } catch { messagesLeft = messagesLeft.concat(part); }
          progress.done += part.length;
          await yieldNow();
        }
      }
      const unmarked = doc?.unmarked ?? 0, gap = doc?.gap === true;
      if (doc) {
        if (!messagesLeft.length && !unmarked && !gap && !left.length) L().origins.remove(userId, kid);
        else L().origins.write(userId, { kid, lines: messagesLeft, at: doc.at, ...(unmarked ? { unmarked } : {}), ...(gap ? { gap: true } : {}) });
      }
      const failed = left.length + messagesLeft.length;
      const markIncomplete = unmarked > 0 || gap;
      const code = failed > 0 ? "forget_incomplete" : markIncomplete ? "mark_incomplete" : undefined;
      return { ok: !code, ...(code ? { code } : {}), forgottenLines: forgotten, ...(olderForgotten ? { forgottenOlderVersions: olderForgotten } : {}), failedLines: failed, deletedMessages: deleted, ...(unmarked ? { notIdentified: unmarked } : {}), ...(markIncomplete ? { markIncomplete: true } : {}) };
    } finally { forgetting.delete(userId); }
  }

  // ───────────────────────── what the screen may see: codes, counts, labels as values ─────────────────────────
  function view(userId: string | null): Record<string, unknown> | null {
    const r = userId ? ctx.load(userId) : null;
    if (!r || !userId) return null;
    const l = lo(r); const w = rec(r.leftoverWork) as unknown as LeftoverWork | null; const code = waiting.get(userId);
    const pointer = ctx.pointer();
    const sender = r.state === "away" ? {
      state: l?.state ?? "none", former: l?.former === true,
      ...(code ? { waiting: code } : {}),
      ...(l?.code ? { kept: l.code } : {}),
      /** The one question about a home that waited its way in or was never seen: [send] or [it was not me] (revertHome). A value, never sent before the answer. */
      ...(code === "ask_unconfirmed" || code === "ask_unseen" ? { ask: { reason: code === "ask_unconfirmed" ? "home_unconfirmed" : "home_not_seen", homeLabel: r.homeLabel ?? null } } : {}),
      ...(code === "cannot_send_yet" ? { cannotSendYet: true } : {}),
      ...(l?.counts ? { counts: l.counts } : {}),
    } : null;
    const origins = r.state === "home" ? L().origins.list(userId) : [];
    const receiver = r.state === "home" ? {
      requests: (requests.get(userId) ?? []).map((q) => ({ kid: q.kid, computer: q.label, bytes: q.bytes, at: q.at })),
      ...(w ? { working: { kid: w.kid, step: w.step, ...(w.wouldStoreFull ? { wouldStoreFull: w.wouldStoreFull } : {}) } } : {}),
      ...(forgetting.has(userId) ? { forgetting: { ...forgetting.get(userId)! } } : {}),
      done: doneList(r).map((e) => ({ kid: e.kid, at: e.at, conversations: e.conversations, ...(e.memoryLinesUnknown ? { memoryLinesUnknown: true } : { memoryLines: e.memoryLines }), reported: e.reported })),
      origins: origins.map((kid) => { const d = L().origins.read(userId, kid); return { kid, label: pointer ? labelOf(pointer, kid) : null, lines: d?.lines.length ?? 0, ...(d && (d.unmarked || d.gap) ? { markIncomplete: true } : {}) }; }),
      ...(code && !sender ? { waiting: code } : {}),
    } : null;
    return sender || receiver ? { sender, receiver } : null;
  }

  /** Sign-out and a change of account (desktop C item 6): the unpacked copy of an old record that has not been imported yet is plaintext of another computer's conversation. It goes (marker proven, `dropWork`); the server keeps the locked
   * record for 30 days and the next pass fetches it again (a missing staged folder is "fetched again", `mergeOne`). Nothing goes once the engine was called (`importing`, marks): those hold what was added and are not re-obtainable. */
  function dropPlaintext(userId: string): void {
    try {
      const r = ctx.load(userId); const w = r ? rec(r.leftoverWork) as unknown as LeftoverWork | null : null;
      if (!w || w.step !== "staged" || w.importing === true || (w.marks && (w.marks.count > 0 || w.marks.ids.length > 0 || w.marks.gap === true))) return;
      dropWork(userId);
    } catch { /* the next pass of this account sweeps it */ }
  }

  return { drive, view, requestSend, requestMerge, forgetFrom, dropPlaintext, _forTest: { waiting, requests } };
}
export type HomeLeftover = ReturnType<typeof createHomeLeftover>;
