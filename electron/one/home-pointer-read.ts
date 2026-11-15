/*
 * The strict reader of the server's pointer (Agentlas 2.0 B8 / F-8). Split out of home.ts. Plain module, no import of home.ts.
 * Contracts: one-home-pointer.md §2 (the shape of the answer). Read by: home.ts (every pointer the server sent: GET and the 409 / 200 of every write).
 */
const PUB_RE = /^[A-Za-z0-9_-]{43}$/;
export const KID_RE = /^[A-Za-z0-9_-]{22}$/;
const CLAIM_ID_RE = /^cl_[A-Za-z0-9_-]{24}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown, max: number): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter(isRecord).slice(0, max) : []);

export interface PointerView {
  home: { kind: "server" } | { kind: "desktop"; hostId: string; label?: string };
  pub: string | null;
  epoch: number;
  homeTrust: "confirmed" | "unconfirmed";
  claims: Array<Record<string, unknown>>;
  pendingDevices: Array<Record<string, unknown>>;
  devices: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

// Audit 59 B8 / F-8: the pointer is the server's text and some of its values become file names (`moveId` -> a folder under the staging folder that is removed at the end; `kid`, `claimId`, `hostId` -> compared and shown).
// `readPointer` therefore copies ONLY the fields this client knows, each checked against its shape, and drops what does not hold. A computer / phone name is cleaned like the server's `cleanLabel`
// (letters, digits, space and `-_.'()` only: control and bidirectional characters go) and cut. Nothing unknown is passed on (no `...rest`).
/** The shape of the server's `newMoveId` (store.ts: `mv_` + 18 random bytes as base64url = 24 characters). */
export const MOVE_ID_RE = /^mv_[A-Za-z0-9_-]{24}$/;
export const HOST_ID_RE = /^[A-Za-z0-9_.:-]{1,96}$/;
export const SHA_HEX_RE = /^[a-f0-9]{64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** A device line's `nonce` is the server's own text (the confirmation number is built from it): its characters and a bound, no fixed length. */
const DEVICE_NONCE_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MASKED_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const LABEL_MAX = 64;
/** The same rule as the web's `cleanLabel` (claims.ts): letters, digits, space and `-_.'()`; everything else (control, bidirectional, zero-width) becomes a space; collapsed, trimmed, cut. */
export function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.slice(0, 512).replace(/[^\p{L}\p{N} \-_.'()]/gu, " ").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, LABEL_MAX).join("").trim() || undefined;
}
const str = (v: unknown, re: RegExp): string | undefined => (typeof v === "string" && re.test(v) ? v : undefined);
const wholeNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
/** A time: the server sends numbers or ISO strings; a value of another kind is dropped. */
const timeVal = (v: unknown): number | string | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.length <= 40 ? v : undefined);
const oneOf = <T extends string>(v: unknown, set: readonly T[]): T | undefined => (typeof v === "string" && (set as readonly string[]).includes(v) ? v as T : undefined);
const put = (o: Record<string, unknown>, k: string, v: unknown): void => { if (v !== undefined) o[k] = v; };
/** Audit 62 / (web `9676c75c`, pointer §20): a claim or a key line that WAITS because the sign-in was not a strong one (Google / Apple within 15 minutes): `{ reason, signinMethods, matureAt }`. Codes and a time only. The value is read every time, never cached: the notice can pull `matureAt` from 7 days to 3. */
export function readWait(v: unknown): { reason: string; signinMethods: string[]; matureAt?: number | string } | undefined {
  if (!isRecord(v) || typeof v.reason !== "string" || !/^[a-z0-9_]{1,48}$/.test(v.reason)) return undefined;
  const methods = Array.isArray(v.signinMethods) ? v.signinMethods.filter((x): x is string => typeof x === "string" && /^[a-z0-9_-]{1,24}$/.test(x)).slice(0, 6) : [];
  const matureAt = timeVal(v.matureAt);
  return { reason: v.reason, signinMethods: methods, ...(matureAt !== undefined ? { matureAt } : {}) };
}

function readHomeRef(v: unknown): PointerView["home"] | null {
  if (!isRecord(v)) return null;
  if (v.kind === "server") return { kind: "server" };
  if (v.kind === "desktop") { const hostId = str(v.hostId, HOST_ID_RE); if (!hostId) return null; const label = cleanLabel(v.label); return { kind: "desktop", hostId, ...(label ? { label } : {}) }; }
  return null;
}
function readFromRef(v: unknown): Record<string, unknown> | undefined {
  if (!isRecord(v)) return undefined;
  if (v.kind === "server") return { kind: "server" };
  if (v.kind === "desktop") { const o: Record<string, unknown> = { kind: "desktop" }; put(o, "hostId", str(v.hostId, HOST_ID_RE)); put(o, "pub", str(v.pub, PUB_RE)); return o; }
  return undefined;
}
function readMoveField(v: unknown): Record<string, unknown> | null {
  if (!isRecord(v)) return null;
  const moveId = str(v.moveId, MOVE_ID_RE);
  if (!moveId) return null;                                                // a move whose id is not an id is no move at all (it would be a folder name)
  const o: Record<string, unknown> = { moveId };
  put(o, "phase", oneOf(v.phase, ["requested", "sealed", "uploaded"] as const));
  const from = readFromRef(v.from); if (from) o.from = from;
  if (isRecord(v.to)) { const t: Record<string, unknown> = {}; put(t, "hostId", str(v.to.hostId, HOST_ID_RE)); put(t, "pub", str(v.to.pub, PUB_RE)); put(t, "label", cleanLabel(v.to.label)); put(t, "boxPub", str(v.to.boxPub, PUB_RE)); put(t, "boxSig", str(v.to.boxSig, /^[A-Za-z0-9_-]{86}$/)); const lim = wholeNum(v.to.limitBytes); if (lim !== undefined && lim >= 1_048_576 && lim <= 1_073_741_824) t.limitBytes = lim; o.to = t; }   // repair 5 / web E-3: what the RECEIVING computer says it can take (1 MiB .. 1 GiB; anything else is not a limit)
  put(o, "startedAt", timeVal(v.startedAt)); put(o, "expiresAt", timeVal(v.expiresAt)); put(o, "exportedAt", timeVal(v.exportedAt));
  if (typeof v.expired === "boolean") o.expired = v.expired;
  put(o, "bytes", wholeNum(v.bytes)); put(o, "sha256", str(v.sha256, SHA_HEX_RE)); put(o, "senderPub", str(v.senderPub, PUB_RE));
  if (isRecord(v.uploadProof)) { const u = v.uploadProof; const p: Record<string, unknown> = {}; put(p, "ts", typeof u.ts === "number" && Number.isFinite(u.ts) ? u.ts : undefined); put(p, "nonce", str(u.nonce, NONCE_RE)); put(p, "sig", str(u.sig, /^[A-Za-z0-9_-]{86}$/)); o.uploadProof = p; }
  if (v.approved === true) o.approved = true;
  if (typeof v.approvedBy === "string" && v.approvedBy.length <= 40) o.approvedBy = v.approvedBy.replace(/[^A-Za-z0-9_-]/g, "");
  if (v.waited === true) o.waited = true;
  // Audit 62 (web `a9bc9a0e`, pointer §19.2): the hard end of a server-origin move, whether the server still holds its fence, and - for an expired move - how long the SAME computer may start again without a new claim.
  put(o, "hardExpiresAt", timeVal(v.hardExpiresAt)); put(o, "resumeUntil", timeVal(v.resumeUntil));
  if (typeof v.fenceHeld === "boolean") o.fenceHeld = v.fenceHeld;
  return o;
}
function readLastField(v: unknown): Record<string, unknown> | null {
  if (!isRecord(v)) return null;
  const o: Record<string, unknown> = {};
  put(o, "moveId", str(v.moveId, MOVE_ID_RE));                             // a `last` whose id is not an id keeps no id (it never equals a move id of this computer); its other fields are still true to the pointer
  put(o, "mode", oneOf(v.mode, ["move", "takeover", "restore", "start-on-server", "revert"] as const));
  put(o, "at", timeVal(v.at)); put(o, "exportedAt", timeVal(v.exportedAt));
  const from = readFromRef(v.from); if (from) o.from = from;
  if (isRecord(v.to) && (v.to.kind === "server" || v.to.kind === "desktop")) o.to = { kind: v.to.kind };
  o.importedAt = v.importedAt === null ? null : timeVal(v.importedAt) ?? null;
  o.purgedAt = v.purgedAt === null ? null : timeVal(v.purgedAt) ?? null;
  if (v.afterRekey === true) o.afterRekey = true;
  put(o, "rejected", wholeNum(v.rejected));
  if (Array.isArray(v.rejectedIds)) o.rejectedIds = v.rejectedIds.slice(0, 200).filter((x): x is string => typeof x === "string" && MASKED_ID_RE.test(x));
  if (v.rejectedIdsTruncated === true) o.rejectedIdsTruncated = true;
  // Audit 61 (web `a500da29`, contract one-home-move §2.8 / pointer §18.2): the new home's signature of `move/imported` as the server keeps it, and whether the server still holds the bundle. A proof that is not whole in every field is no proof.
  if (isRecord(v.importedProof)) {
    const u = v.importedProof; const sent = Array.isArray(u.sent) ? u.sent : null;
    const names = ["rejected", "rejectedIds", "rejectedIdsTruncated"];
    const hostId = str(u.hostId, HOST_ID_RE), nonce = str(u.nonce, NONCE_RE), sig = str(u.sig, /^[A-Za-z0-9_-]{86}$/);
    if (hostId && nonce && sig && typeof u.ts === "number" && Number.isSafeInteger(u.ts) && sent && sent.length <= 3 && sent.every((x) => typeof x === "string" && names.includes(x)) && new Set(sent).size === sent.length) o.importedProof = { hostId, ts: u.ts, nonce, sig, sent: [...sent] };
  }
  if (typeof v.bundleHeld === "boolean") o.bundleHeld = v.bundleHeld;
  // Audit 62 (pointer §19.3): the end of the receiver's wait for the import (the server's own 7 days after the commit) and how many times the old home may still put the bytes again.
  put(o, "importDeadline", timeVal(v.importDeadline)); put(o, "reputsLeft", wholeNum(v.reputsLeft));
  return o;
}
function readClaims(v: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const c of list(v, 8)) {
    const claimId = str(c.claimId, CLAIM_ID_RE); const kind = oneOf(c.kind, ["takeover", "rekey", "to-server", "receive"] as const);
    if (!claimId || !kind) continue;
    const o: Record<string, unknown> = { claimId, kind };
    if (isRecord(c.to)) { const t: Record<string, unknown> = {}; put(t, "hostId", str(c.to.hostId, HOST_ID_RE)); put(t, "pub", str(c.to.pub, PUB_RE)); put(t, "label", cleanLabel(c.to.label)); o.to = t; }
    put(o, "createdAt", timeVal(c.createdAt)); put(o, "matureAt", timeVal(c.matureAt));
    put(o, "expiresAt", timeVal(c.expiresAt)); put(o, "usableFrom", timeVal(c.usableFrom)); put(o, "usableUntil", timeVal(c.usableUntil)); put(o, "approvedAt", timeVal(c.approvedAt)); put(o, "wait", readWait(c.wait));   // (pointer §19.1/§19.7)
    o.approved = c.approved === true; o.noticeOk = c.noticeOk === true;
    put(o, "noticeVia", oneOf(c.noticeVia, ["mail", "push", "device"] as const));
    if (isRecord(c.noticeTry)) { const t: Record<string, unknown> = {}; for (const k of ["mail", "push"] as const) { const code = c.noticeTry[k]; if (typeof code === "string" && /^[A-Za-z0-9_.:-]{1,40}$/.test(code)) t[k] = code; } o.noticeTry = t; }
    out.push(o);
  }
  return out;
}
function readDevices(v: unknown, max: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const d of list(v, max)) {
    const kid = str(d.kid, KID_RE); const kind = oneOf(d.kind, ["phone", "desktop"] as const);
    if (!kid || !kind) continue;
    const o: Record<string, unknown> = { kid, kind };
    put(o, "nonce", str(d.nonce, DEVICE_NONCE_RE)); put(o, "label", cleanLabel(d.label));
    put(o, "registeredAt", timeVal(d.registeredAt)); put(o, "matureAt", timeVal(d.matureAt)); put(o, "trust", oneOf(d.trust, ["home", "aged", "none"] as const));
    put(o, "expiresAt", timeVal(d.expiresAt)); put(o, "trustedAt", timeVal(d.trustedAt)); put(o, "mayConfirmAt", timeVal(d.mayConfirmAt)); put(o, "wait", readWait(d.wait));   // (pointer §19.7)
    if (typeof d.mayConfirm === "boolean") o.mayConfirm = d.mayConfirm;
    // TR-web 2 (E): the server says `viaHome: true` on a phone key the home computer of NOW vouched for (H2, trust-root section 3) and says nothing otherwise. A boolean only; the host id is never in it. Read by: home.ts `status()` (`desktopWork`).
    if (typeof d.viaHome === "boolean") o.viaHome = d.viaHome;
    out.push(o);
  }
  return out;
}
/** `leftoverBox` / `leftoverMerged` belong to the old-record machine (home-leftover.ts): their known fields are checked here; a merged line keeps its other fields as they come (that machine's own proof material lives there). */
function readLeftoverBox(v: unknown): Record<string, unknown> | undefined {
  if (!isRecord(v)) return undefined;
  const o: Record<string, unknown> = {}; put(o, "hostId", str(v.hostId, HOST_ID_RE)); put(o, "pub", str(v.pub, PUB_RE)); put(o, "epoch", wholeNum(v.epoch)); put(o, "boxPub", str(v.boxPub, PUB_RE)); put(o, "boxSig", str(v.boxSig, /^[A-Za-z0-9_-]{86}$/));
  return o;
}
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const PROOF_SENT = ["rejected", "rejectedIds", "rejectedIdsTruncated"] as const;
/** The proof the home signed on a "merged" line or the one a sender signed on an upload (`leftover/list`): known fields in their shapes, nothing else; null when a field that is there does not hold. */
function readLeftoverProof(v: unknown, kind: "merged" | "item"): Record<string, unknown> | null {
  if (!isRecord(v)) return null;
  const o: Record<string, unknown> = {};
  if (v.ts !== undefined) { if (typeof v.ts !== "number" || !Number.isSafeInteger(v.ts)) return null; o.ts = v.ts; }
  if (v.nonce !== undefined) { const n = str(v.nonce, NONCE_RE); if (n === undefined) return null; o.nonce = n; }   /* the server's own NONCE_RE (proof.ts): 16 to 64 base64url characters */
  if (v.sig !== undefined) { const g = str(v.sig, SIG_RE); if (g === undefined) return null; o.sig = g; }
  if (kind === "merged") {
    if (v.hostId !== undefined) { const h = str(v.hostId, HOST_ID_RE); if (h === undefined) return null; o.hostId = h; }
    if (v.sent !== undefined) { if (!Array.isArray(v.sent) || v.sent.length > PROOF_SENT.length || !v.sent.every((x) => (PROOF_SENT as readonly unknown[]).includes(x))) return null; o.sent = [...v.sent]; }
  } else if (v.pub !== undefined) { const p = str(v.pub, PUB_RE); if (p === undefined) return null; o.pub = p; }
  return o;
}
/** One `leftoverMerged` line: the old-record machine (home-leftover.ts) uses `kid` (22) and `sha256` (hex 64) to compare, to name a folder and an index file, and to rebuild the signed text, so a line without both in their shapes is dropped
 * WHOLE, and so is one whose other known field does not hold (desktop C item 3). Only the known fields are copied. */
function readLeftoverMergedLine(line: Record<string, unknown>): Record<string, unknown> | null {
  const kid = str(line.kid, KID_RE), sha256 = str(line.sha256, SHA_HEX_RE);
  if (!kid || !sha256) return null;
  const o: Record<string, unknown> = { kid, sha256 };
  if (line.hostId !== undefined) { const h = str(line.hostId, HOST_ID_RE); if (h === undefined) return null; o.hostId = h; }
  if (line.at !== undefined) { const t = timeVal(line.at); if (t === undefined) return null; o.at = t; }
  for (const k of ["conversations", "memoryLines", "rejected"] as const) if (line[k] !== undefined) { const n = wholeNum(line[k]); if (n === undefined) return null; o[k] = n; }
  if (line.rejectedIds !== undefined) { if (!Array.isArray(line.rejectedIds)) return null; o.rejectedIds = line.rejectedIds.slice(0, 200).filter((x): x is string => typeof x === "string" && MASKED_ID_RE.test(x)); }
  if (line.rejectedIdsTruncated !== undefined) { if (typeof line.rejectedIdsTruncated !== "boolean") return null; o.rejectedIdsTruncated = line.rejectedIdsTruncated; }
  if (line.proof !== undefined) { const proof = readLeftoverProof(line.proof, "merged"); if (!proof) return null; o.proof = proof; }
  return o;
}
function readLeftoverMerged(v: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const line of v.filter(isRecord).slice(0, 8)) { const read = readLeftoverMergedLine(line); if (read) out.push(read); }
  return out;
}
/** The server's `leftover/list` answer: at most 8 items, each `{ kid, sha256, bytes, hostId, at?, proof }` in its shapes. An item that does not hold is dropped whole. `maxBytes` = the largest bundle this desktop takes. */
export function readLeftoverListItems(raw: unknown, maxBytes: number): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const x of raw.filter(isRecord).slice(0, 8)) {
    const kid = str(x.kid, KID_RE), sha256 = str(x.sha256, SHA_HEX_RE), hostId = str(x.hostId, HOST_ID_RE);
    if (!kid || !sha256 || !hostId || !Number.isSafeInteger(x.bytes) || (x.bytes as number) <= 0 || (x.bytes as number) > maxBytes) continue;
    const o: Record<string, unknown> = { kid, sha256, hostId, bytes: x.bytes };
    if (x.at !== undefined) { if (typeof x.at !== "string" || x.at.length > 40) continue; o.at = x.at; }
    if (x.proof !== undefined) { const proof = readLeftoverProof(x.proof, "item"); if (!proof) continue; o.proof = proof; }
    out.push(o);
  }
  return out;
}

/** A pointer the server sent, or null when it is not one. Bounded: no list longer than the server's own limits (claims 3, keys 8). Only known fields, each in its shape (see above). */
export function readPointer(value: unknown): PointerView | null {
  if (!isRecord(value)) return null;
  const home = readHomeRef(value.home);
  if (!home) return null;
  if (typeof value.epoch !== "number" || !Number.isSafeInteger(value.epoch) || value.epoch < 0) return null;
  const out: PointerView = {
    home,
    pub: str(value.pub, PUB_RE) ?? null,
    epoch: value.epoch,
    homeTrust: value.homeTrust === "unconfirmed" ? "unconfirmed" : "confirmed",
    claims: readClaims(value.claims), pendingDevices: readDevices(value.pendingDevices, 16), devices: readDevices(value.devices, 16),
  };
  const keyRev = wholeNum(value.keyRev); if (keyRev !== undefined) out.keyRev = keyRev;
  if (value.writes === "open" || value.writes === "closed") out.writes = value.writes;
  if (typeof value.stored === "boolean") out.stored = value.stored;
  const move = readMoveField(value.move); if (move) out.move = move;
  const last = readLastField(value.last); if (last) out.last = last;
  // Audit 62 (pointer §19.7): while a home is unconfirmed, who may confirm and when it hardens by itself; and what the server still owes (a fence release, a server-copy delete). Shapes only, no text.
  if (isRecord(value.trustInfo)) {
    const t = value.trustInfo; const o: Record<string, unknown> = {};
    put(o, "sinceAt", timeVal(t.sinceAt)); const fh = readHomeRef(t.fromHome); if (fh) o.fromHome = fh;
    o.hardenAt = t.hardenAt === null ? null : timeVal(t.hardenAt) ?? null;
    if (typeof t.selfHardens === "boolean") o.selfHardens = t.selfHardens;
    // Repair 5 / (web `one-home-pointer.md` 21.2): `hardenAt` is a date in every case now and `selfHardens` is always true; `olderTrustedKey` says an older trusted device can still undo the home until then. `blockedBy` is gone from the server (it only ever
    // said "never"); it stays an optional cell of an OLDER server's answer, harmless: no screen is asked to read it.
    put(o, "blockedBy", oneOf(t.blockedBy, ["older_trusted_key"] as const));
    if (typeof t.olderTrustedKey === "boolean") o.olderTrustedKey = t.olderTrustedKey;
    out.trustInfo = o;
  }
  if (isRecord(value.owed)) { const o: Record<string, unknown> = {}; for (const k of ["fenceRelease", "serverCopyDelete"] as const) { const x = value.owed[k]; if (typeof x === "boolean") o[k] = x; else { const tv = timeVal(x); if (tv !== undefined) o[k] = tv; } } out.owed = o; }
  const box = readLeftoverBox(value.leftoverBox); if (box) out.leftoverBox = box;
  const merged = readLeftoverMerged(value.leftoverMerged); if (merged) out.leftoverMerged = merged;
  return out;
}

