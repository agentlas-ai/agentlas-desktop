/*
 * The lock on a computer-to-computer move bundle (Agentlas 2.0 O-M3b, contracts/one-home-move.md §2, byte for byte).
 *
 * Node `crypto` only: X25519 key agreement, HKDF-SHA256, AES-256-GCM, HMAC-SHA256, Ed25519 for `boxSig`. The server never has this code (it cannot open a bundle).
 * No file, no timer, no network here: pure functions over bytes. The box secret key and K_rej are kept by the caller in host-only files (move-secrets).
 *
 *   sealBundle(files, pinned)  -> { bytes, sha256, krej }   bytes = "OHB1" | ephPub(32) | iv(12) | ciphertext | tag(16)
 *   openBundle(bytes, ctx)     -> { files, krej } | { invalid: code }   the tag is checked BEFORE anything is parsed; an unknown file name makes the whole bundle invalid
 *   maskId(krej, id)           -> 22 base64url characters (HMAC-SHA256(K_rej, id)[0..16])
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { BUNDLE_FILES, BUNDLE_MAX_BYTES, BUNDLE_SLACK_BYTES } from "./bundle";

export const BUNDLE_MAGIC = "OHB1";
/** What may travel: the limit plus 1 MiB for the lock around it (derived: / one constant in bundle.ts). */
export const BUNDLE_WIRE_MAX = BUNDLE_MAX_BYTES + 1024 * 1024;
const MAX_FILES = 16;
const ALLOWED_NAMES: ReadonlySet<string> = new Set<string>([...BUNDLE_FILES, "manifest.json"]);
const LF = "\n";
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export interface BoxKeyPair { boxPub: string; secret: Buffer }
export interface SealContext { moveId: string; toPub: string; boxPub: string; senderPub: string }
export interface BundleFile { name: string; bytes: Buffer }

const b64 = (b: Buffer): string => b.toString("base64url");
const x25519Private = (seed: Buffer): crypto.KeyObject => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, seed]), format: "der", type: "pkcs8" });
const x25519Public = (raw: Buffer): crypto.KeyObject => crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
const pubRaw = (key: crypto.KeyObject): Buffer => key.export({ format: "der", type: "spki" }).subarray(-32);
const allZero = (b: Buffer): boolean => b.every((x) => x === 0);

/** A new X25519 pair for one move. `secret` is the 32-byte seed: the caller stores it host-only and deletes it when the move ends. */
export function generateBoxKeyPair(): BoxKeyPair {
  const seed = crypto.randomBytes(32);
  return { boxPub: b64(pubRaw(crypto.createPublicKey(x25519Private(seed)))), secret: seed };
}
export function boxPubFromSeed(seed: Buffer): string { return b64(pubRaw(crypto.createPublicKey(x25519Private(seed)))); }

const boxSigText = (userId: string, hostId: string, boxPub: string): string => `agentlas.one-home.boxsig.v1${LF}${userId}${LF}${hostId}${LF}${boxPub}`;
/** `boxSig` = Ed25519(to key, text) in base64url (86 chars). `edPrivatePkcs8` is the device key as the key store holds it (PKCS8 DER, base64url). */
export function signBoxPub(edPrivatePkcs8: string, userId: string, hostId: string, boxPub: string): string {
  return crypto.sign(null, Buffer.from(boxSigText(userId, hostId, boxPub), "utf8"), crypto.createPrivateKey({ key: Buffer.from(edPrivatePkcs8, "base64url"), format: "der", type: "pkcs8" })).toString("base64url");
}
export function signBoxPubWithSeed(seed: Buffer, userId: string, hostId: string, boxPub: string): string {
  return crypto.sign(null, Buffer.from(boxSigText(userId, hostId, boxPub), "utf8"), crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" })).toString("base64url");
}
export function verifyBoxSig(toPub: string, userId: string, hostId: string, boxPub: string, boxSig: string): boolean {
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(toPub) || !/^[A-Za-z0-9_-]{43}$/.test(boxPub) || !/^[A-Za-z0-9_-]{86}$/.test(boxSig)) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(toPub, "base64url")]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(boxSigText(userId, hostId, boxPub), "utf8"), key, Buffer.from(boxSig, "base64url"));
  } catch { return false; }
}

function deriveKey(shared: Buffer, ctx: SealContext, ephPub: string): { key: Buffer; aad: Buffer } {
  const info = Buffer.from(`agentlas.one-home.bundle.v1${LF}${ephPub}${LF}${ctx.boxPub}${LF}${ctx.toPub}${LF}${ctx.senderPub}`, "utf8");
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(ctx.moveId, "utf8"), info, 32));
  const aad = Buffer.from(`${ctx.moveId}${LF}${ctx.toPub}${LF}${ctx.boxPub}${LF}${ctx.senderPub}`, "utf8");
  return { key, aad };
}
export function deriveKrej(shared: Buffer, moveId: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(moveId, "utf8"), Buffer.from("agentlas.one-home.rejected.v1", "utf8"), 32));
}
/** The id as the server may see it: 22 base64url characters, different for every move (K_rej is per move). */
export function maskId(krej: Buffer, id: string): string {
  return b64(crypto.createHmac("sha256", krej).update(id, "utf8").digest().subarray(0, 16));
}

/** The plaintext as its parts (header, name, size, bytes per file) - not concatenated: a 100 MiB bundle is not copied a second time just to be locked. */
function packParts(files: BundleFile[]): Buffer[] {
  const parts: Buffer[] = [];
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const head = Buffer.alloc(2); head.writeUInt16BE(name.length);
    const size = Buffer.alloc(4); size.writeUInt32BE(f.bytes.length);
    parts.push(head, name, size, f.bytes);
  }
  return parts;
}
const SLICE = 1 << 20;
const partsLength = (parts: Buffer[]): number => parts.reduce((n, p) => n + p.length, 0);
/**
 * magic + ephemeral key + iv + ciphertext + tag as ONE buffer, written once: the cipher is fed in 1 MiB slices and each slice's output is copied straight into place (AES-GCM streams: the bytes are the same as one `update` over the whole text).
 * Peak memory is the parts the caller already holds plus this one buffer, not four copies of the bundle.
 */
function lockParts(magic: string, ephPub: Buffer, iv: Buffer, cipher: crypto.CipherGCM, parts: Buffer[]): Buffer {
  const out = Buffer.allocUnsafe(4 + ephPub.length + iv.length + partsLength(parts) + 16);
  let at = out.write(magic, 0, "ascii"); at += ephPub.copy(out, at); at += iv.copy(out, at);
  for (const part of parts) for (let o = 0; o < part.length; o += SLICE) at += cipher.update(part.subarray(o, o + SLICE)).copy(out, at);
  at += cipher.final().copy(out, at);
  if (at !== out.length - 16) throw new Error("seal_length");
  cipher.getAuthTag().copy(out, at);
  return out;
}
/** The reverse: the plaintext is written once into one buffer of the ciphertext's size (slices through the decipher); `final()` throws when any byte or context value differs, as before. */
function unlockBody(decipher: crypto.DecipherGCM, body: Buffer): Buffer {
  const plain = Buffer.allocUnsafe(body.length); let at = 0;
  for (let o = 0; o < body.length; o += SLICE) at += decipher.update(body.subarray(o, o + SLICE)).copy(plain, at);
  decipher.final();
  return plain.subarray(0, at);
}

/** Test seam: fixed key material and iv (the contract's vectors). Product code never passes it. */
export interface SealFixture { ephSeed?: Buffer; iv?: Buffer }

/** Locks the files for one receiver. `ctx` is the PINNED (moveId, toPub, boxPub, senderPub). Answers `{ invalid }` for a zero/low-order key; throws `files_invalid` only for a file list that is not the allowed one (a programming error of the sender). */
export function sealBundle(files: BundleFile[], ctx: SealContext, fixture: SealFixture = {}): SealResult {
  if (files.length > MAX_FILES || files.some((f) => !ALLOWED_NAMES.has(f.name)) || new Set(files.map((f) => f.name)).size !== files.length) throw new Error("files_invalid");
  const plain = packParts(files);
  if (partsLength(plain) > BUNDLE_MAX_BYTES + BUNDLE_SLACK_BYTES) throw new Error("files_invalid");
  return sealPlain(plain, ctx, fixture);
}

/** The lock itself over a plaintext (§2.2). Exported so the contract's vector 1 (raw text) can be checked byte for byte. */
export type SealResult = { bytes: Buffer; sha256: string; krej: Buffer } | { invalid: string };
export function sealPlain(plain: Buffer | Buffer[], ctx: SealContext, fixture: SealFixture = {}): SealResult {
  const eph = fixture.ephSeed ?? crypto.randomBytes(32);
  const ephKey = x25519Private(eph);
  const ephPub = pubRaw(crypto.createPublicKey(ephKey));
  let shared: Buffer;
  // An all-zero (or other low-order) public key: Node throws ERR_OSSL_FAILED_DURING_DERIVATION by itself, and a zero shared secret is refused here. Both are `invalid`, never a throw up the step machine.
  try { shared = crypto.diffieHellman({ privateKey: ephKey, publicKey: x25519Public(Buffer.from(ctx.boxPub, "base64url")) }); } catch { return { invalid: "shared_secret_zero" }; }
  if (allZero(shared)) return { invalid: "shared_secret_zero" };
  const { key, aad } = deriveKey(shared, ctx, b64(ephPub));
  const iv = fixture.iv ?? crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad);
  const bytes = lockParts(BUNDLE_MAGIC, ephPub, iv, cipher, Array.isArray(plain) ? plain : [plain]);
  return { bytes, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), krej: deriveKrej(shared, ctx.moveId) };
}

export type OpenResult = { files: BundleFile[]; krej: Buffer } | { invalid: string };

/** Opens a bundle. `ctx.senderPub` is the one the receiver wrote down at `move/start` (never the pointer's current key). Nothing is parsed before the tag is verified. */
export function openBundle(bytes: Buffer, boxSeed: Buffer, ctx: SealContext): OpenResult {
  if (bytes.length < 64 || bytes.length > BUNDLE_WIRE_MAX || bytes.subarray(0, 4).toString("ascii") !== BUNDLE_MAGIC) return { invalid: "bundle_magic" };
  return openCore(bytes.subarray(4, 36), bytes.subarray(36, 48), bytes.subarray(bytes.length - 16), (decipher) => unlockBody(decipher, bytes.subarray(48, bytes.length - 16)), boxSeed, ctx);
}
/**
 * The same, from a FILE: the 48-byte head and the 16-byte tag are read first, the cipher is given the tag, and the body is read in 1 MiB slices straight into the one plaintext buffer - the locked bytes are never in memory beside it
 * (a 100 MiB bundle: about one copy, not two). Nothing is parsed before the tag verified (`final()` throws otherwise: `bundle_tag`).
 */
export function openBundleFile(file: string, boxSeed: Buffer, ctx: SealContext): OpenResult {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    if (size < 64 || size > BUNDLE_WIRE_MAX) return { invalid: "bundle_magic" };
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(48); fs.readSync(fd, head, 0, 48, 0);
    if (head.subarray(0, 4).toString("ascii") !== BUNDLE_MAGIC) return { invalid: "bundle_magic" };
    const tag = Buffer.alloc(16); fs.readSync(fd, tag, 0, 16, size - 16);
    const bodyLen = size - 64; const handle = fd;
    return openCore(head.subarray(4, 36), head.subarray(36, 48), tag, (decipher) => {
      const plain = Buffer.allocUnsafe(bodyLen); const slice = Buffer.allocUnsafe(SLICE); let at = 0, pos = 48;
      while (at < bodyLen) { const n = fs.readSync(handle, slice, 0, Math.min(SLICE, bodyLen - at), pos); if (n <= 0) throw new Error("short_read"); at += decipher.update(slice.subarray(0, n)).copy(plain, at); pos += n; }
      decipher.final();
      return plain.subarray(0, at);
    }, boxSeed, ctx);
  } catch { return { invalid: "bundle_tag" }; } finally { try { if (fd !== null) fs.closeSync(fd); } catch { /* closed */ } }
}
function openCore(ephRaw: Buffer, iv: Buffer, tag: Buffer, unlock: (decipher: crypto.DecipherGCM) => Buffer, boxSeed: Buffer, ctx: SealContext): OpenResult {
  try {
    let shared: Buffer;
    try { shared = crypto.diffieHellman({ privateKey: x25519Private(boxSeed), publicKey: x25519Public(Buffer.from(ephRaw)) }); } catch { return { invalid: "shared_secret_zero" }; }
    if (allZero(shared)) return { invalid: "shared_secret_zero" };
    const { key, aad } = deriveKey(shared, ctx, b64(Buffer.from(ephRaw)));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 }); decipher.setAAD(aad); decipher.setAuthTag(tag);
    const plain = unlock(decipher);   // throws when any context value or any byte differs
    const files: BundleFile[] = [];
    let at = 0, total = 0;
    const seen = new Set<string>();
    while (at < plain.length) {
      if (files.length >= MAX_FILES || at + 2 > plain.length) return { invalid: "bundle_files" };
      const nameLen = plain.readUInt16BE(at); at += 2;
      if (nameLen === 0 || nameLen > 64 || at + nameLen + 4 > plain.length) return { invalid: "bundle_files" };
      const name = plain.subarray(at, at + nameLen).toString("utf8"); at += nameLen;
      if (!ALLOWED_NAMES.has(name) || seen.has(name)) return { invalid: "bundle_file_not_allowed" };   // the whole bundle, never half of it
      const size = plain.readUInt32BE(at); at += 4;
      if (at + size > plain.length) return { invalid: "bundle_files" };
      total += size;
      if (total > BUNDLE_MAX_BYTES + BUNDLE_SLACK_BYTES) return { invalid: "bundle_too_large" };
      seen.add(name);
      files.push({ name, bytes: plain.subarray(at, at + size) }); at += size;   // a view of the one plaintext buffer (/ no copy per file)
    }
    return { files, krej: deriveKrej(shared, ctx.moveId) };
  } catch { return { invalid: "bundle_tag" }; }
}

// ───────────────────────── the lock on a leftover record (O-M4b, contracts/one-home-leftover.md §1.2 and §2, byte for byte) ─────────────────────────
// Same structure as the move bundle's lock; different context string, magic and context values: the receiver's key is the HOME's long-lived leftover box key (not a per-move key),
// there is no move id (the account id, the home's key and the sender's key are in the context), and the allowed file list is shorter (no check-ins, settings or rules file).

export const LEFTOVER_MAGIC = "OHL1";
const LEFTOVER_NAMES: ReadonlySet<string> = new Set(["manifest.json", "memory.sqlite", "conversation.jsonl", "context-seed.json", "profile.json", "avatar.bin"]);
export interface LeftoverContext { userId: string; homePub: string; boxPub: string; senderPub: string }

const leftoverBoxSigText = (userId: string, hostId: string, epoch: number, boxPub: string): string => `agentlas.one-home.leftover-boxsig.v1${LF}${userId}${LF}${hostId}${LF}${epoch}${LF}${boxPub}`;
/** `boxSig` of the home's leftover box key: Ed25519(home key, text) in base64url (86 chars). */
export function signLeftoverBox(edPrivatePkcs8: string, userId: string, hostId: string, epoch: number, boxPub: string): string {
  return crypto.sign(null, Buffer.from(leftoverBoxSigText(userId, hostId, epoch, boxPub), "utf8"), crypto.createPrivateKey({ key: Buffer.from(edPrivatePkcs8, "base64url"), format: "der", type: "pkcs8" })).toString("base64url");
}
export function signLeftoverBoxWithSeed(seed: Buffer, userId: string, hostId: string, epoch: number, boxPub: string): string {
  return crypto.sign(null, Buffer.from(leftoverBoxSigText(userId, hostId, epoch, boxPub), "utf8"), crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" })).toString("base64url");
}
export function verifyLeftoverBoxSig(homePub: string, userId: string, hostId: string, epoch: number, boxPub: string, boxSig: string): boolean {
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(homePub) || !/^[A-Za-z0-9_-]{43}$/.test(boxPub) || !/^[A-Za-z0-9_-]{86}$/.test(boxSig) || !Number.isSafeInteger(epoch) || epoch < 0) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(homePub, "base64url")]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(leftoverBoxSigText(userId, hostId, epoch, boxPub), "utf8"), key, Buffer.from(boxSig, "base64url"));
  } catch { return false; }
}

function deriveLeftoverKey(shared: Buffer, ctx: LeftoverContext, ephPub: string): { key: Buffer; aad: Buffer } {
  const info = Buffer.from(`agentlas.one-home.leftover.v1${LF}${ephPub}${LF}${ctx.boxPub}${LF}${ctx.homePub}${LF}${ctx.senderPub}`, "utf8");
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(ctx.userId, "utf8"), info, 32));
  const aad = Buffer.from(`${ctx.userId}${LF}${ctx.homePub}${LF}${ctx.boxPub}${LF}${ctx.senderPub}`, "utf8");
  return { key, aad };
}

/**
 * K_rejL (security follow-up of O-M3b/O-M4b, one-home-leftover.md): the key that hides, from the server, the ids of the lines the home did not take from an old record. Bound to the locked bytes' sha-256, so a
 * re-lock (new ephemeral key, new bytes) gets a different key and can never mask against the wrong record. Both sides get the same `shared`; the masked id is `maskId(krejL, id)` (HMAC-SHA256, first 16 bytes, 22 characters).
 */
export function deriveKrejL(shared: Buffer, sha256: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(sha256, "utf8"), Buffer.from("agentlas.one-home.leftover.rejected.v1", "utf8"), 32));
}

/** The lock itself over a plaintext (contract §2). Exported so vectors 1 and 2 (raw text) can be checked byte for byte. */
export function sealLeftoverPlain(plain: Buffer | Buffer[], ctx: LeftoverContext, fixture: SealFixture = {}): { bytes: Buffer; sha256: string; krejL: Buffer } | { invalid: string } {
  const eph = fixture.ephSeed ?? crypto.randomBytes(32);
  const ephKey = x25519Private(eph);
  const ephPub = pubRaw(crypto.createPublicKey(ephKey));
  let shared: Buffer;
  try { shared = crypto.diffieHellman({ privateKey: ephKey, publicKey: x25519Public(Buffer.from(ctx.boxPub, "base64url")) }); } catch { return { invalid: "shared_secret_zero" }; }
  if (allZero(shared)) return { invalid: "shared_secret_zero" };
  const { key, aad } = deriveLeftoverKey(shared, ctx, b64(ephPub));
  const iv = fixture.iv ?? crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad);
  const bytes = lockParts(LEFTOVER_MAGIC, ephPub, iv, cipher, Array.isArray(plain) ? plain : [plain]);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, krejL: deriveKrejL(shared, sha256) };
}
/** Locks the files of a leftover record. Throws `files_invalid` for a name outside the list (a programming error of the sender: a check-in file or a rules file must never be locked). */
export function sealLeftover(files: BundleFile[], ctx: LeftoverContext, fixture: SealFixture = {}): { bytes: Buffer; sha256: string; krejL: Buffer } | { invalid: string } {
  if (files.length > MAX_FILES || files.some((f) => !LEFTOVER_NAMES.has(f.name)) || new Set(files.map((f) => f.name)).size !== files.length) throw new Error("files_invalid");
  const plain = packParts(files);
  if (partsLength(plain) > BUNDLE_MAX_BYTES + BUNDLE_SLACK_BYTES) throw new Error("files_invalid");
  return sealLeftoverPlain(plain, ctx, fixture);
}
/** Opens a leftover record. The tag is checked before anything is parsed; a name outside the list, a repeated name, a path character, more than 16 files or more than 8 MiB makes the whole record `invalid`. */
export function openLeftover(bytes: Buffer, boxSeed: Buffer, ctx: LeftoverContext): { files: BundleFile[]; krejL: Buffer } | { invalid: string } {
  if (bytes.length < 64 || bytes.length > BUNDLE_WIRE_MAX || bytes.subarray(0, 4).toString("ascii") !== LEFTOVER_MAGIC) return { invalid: "bundle_magic" };
  try {
    const ephRaw = bytes.subarray(4, 36), iv = bytes.subarray(36, 48), tag = bytes.subarray(bytes.length - 16), body = bytes.subarray(48, bytes.length - 16);
    let shared: Buffer;
    try { shared = crypto.diffieHellman({ privateKey: x25519Private(boxSeed), publicKey: x25519Public(Buffer.from(ephRaw)) }); } catch { return { invalid: "shared_secret_zero" }; }
    if (allZero(shared)) return { invalid: "shared_secret_zero" };
    const { key, aad } = deriveLeftoverKey(shared, ctx, b64(Buffer.from(ephRaw)));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 }); decipher.setAAD(aad); decipher.setAuthTag(tag);
    const plain = unlockBody(decipher, body);
    const files: BundleFile[] = [];
    let at = 0, total = 0;
    const seen = new Set<string>();
    while (at < plain.length) {
      if (files.length >= MAX_FILES || at + 2 > plain.length) return { invalid: "bundle_files" };
      const nameLen = plain.readUInt16BE(at); at += 2;
      if (nameLen === 0 || nameLen > 64 || at + nameLen + 4 > plain.length) return { invalid: "bundle_files" };
      const name = plain.subarray(at, at + nameLen).toString("utf8"); at += nameLen;
      if (!LEFTOVER_NAMES.has(name) || seen.has(name)) return { invalid: "bundle_file_not_allowed" };
      const size = plain.readUInt32BE(at); at += 4;
      if (at + size > plain.length) return { invalid: "bundle_files" };
      total += size;
      if (total > BUNDLE_MAX_BYTES + BUNDLE_SLACK_BYTES) return { invalid: "bundle_too_large" };
      seen.add(name);
      files.push({ name, bytes: plain.subarray(at, at + size) }); at += size;   // a view of the one plaintext buffer (/ no copy per file)
    }
    return { files, krejL: deriveKrejL(shared, crypto.createHash("sha256").update(bytes).digest("hex")) };
  } catch { return { invalid: "bundle_tag" }; }
}
