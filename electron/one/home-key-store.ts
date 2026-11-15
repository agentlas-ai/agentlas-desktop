/*
 * Where this computer's one-home private key lives (Agentlas 2.0 O-M3a follow-up F2).
 *
 * Not in the app database: the database is copied whole (update continuity backup updater/continuity.ts:1017 `source.backup`, upgrade image
 * store/db.ts:1300 `VACUUM INTO`, the legacy-session backup runtime/legacy-product-sessions.ts:189 `VACUUM INTO`, a Cloud computer's snapshot
 * managed-one/snapshot.ts:7). A host-only file beside the mobile bridge identity is copied by none of them: the continuity backup copies the
 * database and the `agents/` folder only (continuity.ts:1041), and the Cloud snapshot lists "not in it: the mobile bridge identity and pairings
 * (they belong to one host id)" (snapshot.ts:12-13).
 *
 * The file is wrapped with Electron `safeStorage` like the login cookie (auth.ts). Where `safeStorage` is not usable (no keyring on Linux, the
 * background service, a managed host) there is NO key: nothing is written in the clear, `write` answers false, and the caller answers a code.
 *
 * One small file per account: `<userData>/mobile-bridge/one-home-key.<24 hex of sha256(userId)>.json`, mode 0600, written atomically.
 * Read by one/home.ts (signing, in Main, where there is a session). Deleted by `remove` when the account slot is forgotten (forgetAccountSlot);
 * a sign-out keeps it (the key is this computer's identity on the server, and the next sign-in needs the same one).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writePrivateJsonAtomic } from "../mobile-bridge/pairing";

export interface HomeKeyMaterial { privateKey: string; pub: string; kid: string }
export interface SafeStoragePort {
  isEncryptionAvailable(): boolean; encryptString(plain: string): Buffer; decryptString(encrypted: Buffer): string;
  /** Linux only (Electron >= 29): "basic_text" means the keyring is missing and the value is wrapped with a fixed password, i.e. in effect in the clear. */
  getSelectedStorageBackend?(): string;
}
export interface HomeKeyStore {
  /** True only when the key can be wrapped (a missing or unusable safeStorage is false, never a plain-text fallback). */
  available(): boolean;
  read(userId: string): HomeKeyMaterial | null;
  write(userId: string, key: HomeKeyMaterial): boolean;
  remove(userId: string): void;
}

const PUB_RE = /^[A-Za-z0-9_-]{43}$/;
const KID_RE = /^[A-Za-z0-9_-]{22}$/;

export function createHomeKeyStore(input: { dir: () => string; safeStorage: () => SafeStoragePort | null }): HomeKeyStore {
  const usable = (): SafeStoragePort | null => {
    try {
      const s = input.safeStorage();
      if (!s || !s.isEncryptionAvailable()) return null;
      // Security review N3: on Linux a `basic_text` backend is no protection. Where the method does not exist (other platforms, older Electron) the answer is the one above; it never throws.
      if (process.platform === "linux" && typeof s.getSelectedStorageBackend === "function") { try { if (s.getSelectedStorageBackend() === "basic_text") return null; } catch { /* unknown backend: keep the answer above */ } }
      return s;
    } catch { return null; }
  };
  const file = (userId: string): string => path.join(input.dir(), `one-home-key.${createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 24)}.json`);
  return {
    available: () => usable() !== null,
    read(userId) {
      const s = usable(); if (!s) return null;
      try {
        const doc = JSON.parse(fs.readFileSync(file(userId), "utf8")) as { version?: unknown; encoding?: unknown; value?: unknown };
        if (doc.version !== 1 || doc.encoding !== "safeStorage/base64" || typeof doc.value !== "string") return null;
        const key = JSON.parse(s.decryptString(Buffer.from(doc.value, "base64"))) as Partial<HomeKeyMaterial>;
        return typeof key.privateKey === "string" && typeof key.pub === "string" && PUB_RE.test(key.pub) && typeof key.kid === "string" && KID_RE.test(key.kid)
          ? { privateKey: key.privateKey, pub: key.pub, kid: key.kid } : null;
      } catch { return null; }
    },
    write(userId, key) {
      const s = usable(); if (!s) return false;
      try {
        writePrivateJsonAtomic(file(userId), { version: 1, encoding: "safeStorage/base64", value: s.encryptString(JSON.stringify(key)).toString("base64"), updatedAt: new Date().toISOString() });
        return true;
      } catch { return false; }
    },
    remove(userId) { try { fs.rmSync(file(userId), { force: true }); } catch { /* best effort: the next call sees it again */ } },
  };
}

/**
 * Host-only secrets of ONE move: the box secret key (receiver) and K_rej (both sides), contracts/one-home-move.md §2.3-2.4 and §3.1 (`move.boxPrivateKey`/`krejFile` are names, never the key).
 * One small file per (account, name) in `<userData>/one-move/<24 hex of sha256(userId)>/`, wrapped with safeStorage like the device key (same `usable()`: no keyring / `basic_text` = no file, `write` answers false).
 * Read by: the move steps (open the bundle, mask refused ids, unmask for the purge). Deleted: `remove` when the move ends (import reported, purge done, cancel, expiry), and `removeAll(userId)`.
 */
/** `box`, `krej` (receiver: one bundle opened), `krej.<16 hex of the locked bytes' sha-256>` (sender: K_rej bound to the bytes it belongs to; never overwritten by a re-lock). */
export type MoveSecretName = "box" | "krej" | `krej.${string}`;
const SAFE_NAME = /^(box|krej|krej\.[0-9a-f]{16})$/;
export interface MoveSecretStore {
  write(userId: string, moveId: string, name: MoveSecretName, bytes: Buffer): boolean;
  read(userId: string, moveId: string, name: MoveSecretName): Buffer | null;
  remove(userId: string, moveId: string, name: MoveSecretName): void;
  /** Every secret file of this move (any name). Returns how many were removed. */
  removeMove(userId: string, moveId: string): number;
  /** True when any secret file of this move is still there. */
  existsAny(userId: string, moveId: string): boolean;
  /** Every secret file of this account that does not belong to `keepMoveId`: for the restart sweep. Returns how many were removed. */
  removeOthers(userId: string, keepMoveId: string | null): number;
  exists(userId: string, moveId: string, name: MoveSecretName): boolean;
  /** The `krej.<16 hex>` names this move has (F-2: the purge picks the one that goes with the bytes the receiver opened). */
  krejNames(userId: string, moveId: string): Array<`krej.${string}`>;
}
export function createMoveSecretStore(input: { dir: (userId: string) => string; safeStorage: () => SafeStoragePort | null }): MoveSecretStore {
  const keyStore = createHomeKeyStore({ dir: () => "", safeStorage: input.safeStorage });
  const usable = (): SafeStoragePort | null => (keyStore.available() ? input.safeStorage() : null);
  const SAFE_MOVE = /^[A-Za-z0-9_.:-]{1,64}$/;
  const file = (userId: string, moveId: string, name: string): string => path.join(input.dir(userId), `secret.${moveId.replace(/:/g, "_")}.${name}.json`);
  return {
    write(userId, moveId, name, bytes) {
      const s = usable(); if (!s || !SAFE_MOVE.test(moveId) || !SAFE_NAME.test(name)) return false;
      try { writePrivateJsonAtomic(file(userId, moveId, name), { version: 1, encoding: "safeStorage/base64", value: s.encryptString(bytes.toString("base64url")).toString("base64") }); return true; } catch { return false; }
    },
    read(userId, moveId, name) {
      const s = usable(); if (!s || !SAFE_MOVE.test(moveId) || !SAFE_NAME.test(name)) return null;
      try {
        const doc = JSON.parse(fs.readFileSync(file(userId, moveId, name), "utf8")) as { version?: unknown; encoding?: unknown; value?: unknown };
        if (doc.version !== 1 || doc.encoding !== "safeStorage/base64" || typeof doc.value !== "string") return null;
        return Buffer.from(s.decryptString(Buffer.from(doc.value, "base64")), "base64url");
      } catch { return null; }
    },
    remove(userId, moveId, name) { if (SAFE_MOVE.test(moveId) && SAFE_NAME.test(name)) { try { fs.rmSync(file(userId, moveId, name), { force: true }); } catch { /* checked by exists() */ } } },
    exists(userId, moveId, name) { return SAFE_MOVE.test(moveId) && SAFE_NAME.test(name) && fs.existsSync(file(userId, moveId, name)); },
    removeMove(userId, moveId) {
      let n = 0;
      if (!SAFE_MOVE.test(moveId)) return 0;
      try { const pre = `secret.${moveId.replace(/:/g, "_")}.`; for (const f of fs.readdirSync(input.dir(userId))) if (f.startsWith(pre)) { fs.rmSync(path.join(input.dir(userId), f), { force: true }); n += 1; } } catch { /* no folder */ }
      return n;
    },
    existsAny(userId, moveId) {
      if (!SAFE_MOVE.test(moveId)) return false;
      try { const pre = `secret.${moveId.replace(/:/g, "_")}.`; return fs.readdirSync(input.dir(userId)).some((f) => f.startsWith(pre)); } catch { return false; }
    },
    krejNames(userId, moveId) {
      if (!SAFE_MOVE.test(moveId)) return [];
      try {
        const pre = `secret.${moveId.replace(/:/g, "_")}.`;
        return fs.readdirSync(input.dir(userId)).filter((f) => f.startsWith(pre) && f.endsWith(".json")).map((f) => f.slice(pre.length, -".json".length)).filter((n): n is `krej.${string}` => /^krej\.[0-9a-f]{16}$/.test(n));
      } catch { return []; }
    },
    removeOthers(userId, keepMoveId) {
      let n = 0;
      try {
        const keep = keepMoveId ? `secret.${keepMoveId.replace(/:/g, "_")}.` : null;
        for (const f of fs.readdirSync(input.dir(userId))) if (f.startsWith("secret.") && (!keep || !f.startsWith(keep))) { fs.rmSync(path.join(input.dir(userId), f), { force: true }); n += 1; }
      } catch { /* no folder */ }
      return n;
    },
  };
}

/**
 * The home's leftover box secret (Agentlas 2.0 O-M4b): the X25519 seed whose public half the home publishes once so that other computers can lock their old records to it.
 * It is long-lived (a move's secrets die with the move), so it lives beside the device key, not in `one-move/`: `<dir>/one-home-leftover-box.<24 hex of sha256(userId)>.json`, wrapped with safeStorage,
 * 0600, atomic. Read by: the home's leftover merge (open a record). Replaced: when the home's key or epoch changes (a new seed; records locked to the old one are dropped by the server).
 * Deleted: `remove` when the account slot is forgotten. No usable safeStorage = no seed, `write` answers false.
 */
export interface LeftoverBoxStore {
  read(userId: string): Buffer | null; write(userId: string, seed: Buffer): boolean; remove(userId: string): void;
  /**
   * K_rejL of one old record (sender: made at lock time; home: made at open time), bound to the locked bytes' sha-256 (never overwritten by another record's key). One small file each beside the box seed:
   * `one-home-leftover-krej.<24 hex of sha256(userId)>.<16 hex of the record's sha-256>.json`. Read by: the sender's purge / the home's masking of refused ids. Deleted: `removeKrej` when the purge ends, the record is re-locked,
   * the merge is reported or the work is dropped; `removeKrej(userId)` without a sha removes every one of the account.
   */
  writeKrej(userId: string, sha256: string, key: Buffer): boolean; readKrej(userId: string, sha256: string): Buffer | null; removeKrej(userId: string, sha256?: string, exceptSha?: string): void;
}
export function createLeftoverBoxStore(input: { dir: () => string; safeStorage: () => SafeStoragePort | null }): LeftoverBoxStore {
  const keyStore = createHomeKeyStore({ dir: () => "", safeStorage: input.safeStorage });
  const usable = (): SafeStoragePort | null => (keyStore.available() ? input.safeStorage() : null);
  const acct = (userId: string): string => createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 24);
  const file = (userId: string): string => path.join(input.dir(), `one-home-leftover-box.${acct(userId)}.json`);
  const krejFile = (userId: string, sha256: string): string => path.join(input.dir(), `one-home-leftover-krej.${acct(userId)}.${sha256.slice(0, 16)}.json`);
  return {
    read(userId) {
      const s = usable(); if (!s) return null;
      try {
        const doc = JSON.parse(fs.readFileSync(file(userId), "utf8")) as { version?: unknown; encoding?: unknown; value?: unknown };
        if (doc.version !== 1 || doc.encoding !== "safeStorage/base64" || typeof doc.value !== "string") return null;
        const seed = Buffer.from(s.decryptString(Buffer.from(doc.value, "base64")), "base64url");
        return seed.length === 32 ? seed : null;
      } catch { return null; }
    },
    write(userId, seed) {
      const s = usable(); if (!s || seed.length !== 32) return false;
      try { writePrivateJsonAtomic(file(userId), { version: 1, encoding: "safeStorage/base64", value: s.encryptString(seed.toString("base64url")).toString("base64"), updatedAt: new Date().toISOString() }); return true; } catch { return false; }
    },
    remove(userId) { try { fs.rmSync(file(userId), { force: true }); } catch { /* best effort */ } },
    writeKrej(userId, sha256, key) {
      const s = usable(); if (!s || !/^[a-f0-9]{64}$/.test(sha256) || key.length !== 32) return false;
      try { writePrivateJsonAtomic(krejFile(userId, sha256), { version: 1, encoding: "safeStorage/base64", value: s.encryptString(key.toString("base64url")).toString("base64"), updatedAt: new Date().toISOString() }); return true; } catch { return false; }
    },
    readKrej(userId, sha256) {
      const s = usable(); if (!s || !/^[a-f0-9]{64}$/.test(sha256)) return null;
      try {
        const doc = JSON.parse(fs.readFileSync(krejFile(userId, sha256), "utf8")) as { version?: unknown; encoding?: unknown; value?: unknown };
        if (doc.version !== 1 || doc.encoding !== "safeStorage/base64" || typeof doc.value !== "string") return null;
        const k = Buffer.from(s.decryptString(Buffer.from(doc.value, "base64")), "base64url");
        return k.length === 32 ? k : null;
      } catch { return null; }
    },
    removeKrej(userId, sha256, exceptSha) {
      try {
        const pre = `one-home-leftover-krej.${acct(userId)}.`;
        for (const f of fs.readdirSync(input.dir())) {
          if (!f.startsWith(pre)) continue;
          const tag = f.slice(pre.length, pre.length + 16);
          if (sha256 !== undefined && tag !== sha256.slice(0, 16)) continue;
          if (exceptSha !== undefined && tag === exceptSha.slice(0, 16)) continue;
          fs.rmSync(path.join(input.dir(), f), { force: true });
        }
      } catch { /* no folder */ }
    },
  };
}
