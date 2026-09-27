import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readMacInstalledAppSignedIdentity,
  readMacReleaseSigningPolicy,
  type MacTrustCommandRunner,
} from "../updater/mac-app-trust";

/**
 * PASS-only cache for the official macOS runtime seal.
 *
 * The full gate (`codesign --verify --deep --strict` + `spctl`) hashes the
 * whole 1.7GB bundle: 3.4–5.8s per launch, twice after an update. A PASS may
 * be reused only while every one of these is byte-identical to the moment the
 * full gate passed:
 *   - realpath of the .app, CFBundleVersion, CFBundleShortVersionString
 *   - dev/ino/size/mtime/ctime of Contents/_CodeSignature/CodeResources,
 *     the main executable and Info.plist
 *   - the CDHash, bundle identifier, team and leaf authority (`codesign -d`)
 *   - sha256 of the signing policy, the OS release/build
 *   - an lstat digest of EVERY entry in the bundle (path, type, mode, size,
 *     dev, ino, mtime, ctime, link target). Any write, chmod, rename, add or
 *     remove anywhere in the bundle changes ctime/ino/the entry set, and
 *     user space cannot set ctime, so content drift cannot hide behind an
 *     unchanged CodeResources.
 * and the PASS is younger than MAX_AGE_MS (Gatekeeper/revocation freshness).
 *
 * A FAIL is never written. A missing, malformed, foreign-owned, linked or
 * stale record means the full gate. A version change is a different identity,
 * so the first launch after every update runs the full gate.
 */

export const MAC_RUNTIME_TRUST_CACHE_SCHEMA = "agentlas.mac-runtime-seal-pass.v1";
export const MAC_RUNTIME_TRUST_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_TREE_ENTRIES = 250_000;

type FileIdentity = { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string };

export type MacBundleIdentity = {
  bundleRealpath: string;
  bundleVersion: string;
  shortVersion: string;
  cdhash: string;
  codeResources: FileIdentity;
  mainExecutable: FileIdentity;
  infoPlist: FileIdentity;
  policySha256: string;
  osRelease: string;
  osVersion: string;
  tree: { entries: number; sha256: string };
};

type CacheRecord = {
  schema: typeof MAC_RUNTIME_TRUST_CACHE_SCHEMA;
  recordedAt: number;
  identity: MacBundleIdentity;
};

function fileIdentity(file: string): FileIdentity | null {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

/** Deterministic lstat digest of the whole bundle; never follows links. */
export function macBundleTreeDigest(bundleRoot: string): { entries: number; sha256: string } | null {
  const hash = createHash("sha256");
  let entries = 0;
  const visit = (absolute: string, relative: string): boolean => {
    if (++entries > MAX_TREE_ENTRIES) return false;
    const stat = fs.lstatSync(absolute, { bigint: true });
    const type = stat.isSymbolicLink() ? "l" : stat.isDirectory() ? "d" : stat.isFile() ? "f" : "o";
    hash.update(`${relative}\0${type}\0${stat.mode}\0${stat.size}\0${stat.dev}\0${stat.ino}\0${stat.mtimeNs}\0${stat.ctimeNs}\0`);
    if (type === "l") hash.update(fs.readlinkSync(absolute));
    hash.update("\n");
    if (type !== "d") return true;
    const names = fs.readdirSync(absolute).sort();
    for (const name of names) {
      if (!visit(path.join(absolute, name), relative ? `${relative}/${name}` : name)) return false;
    }
    return true;
  };
  try {
    if (!visit(bundleRoot, "")) return null;
  } catch {
    return null;
  }
  return { entries, sha256: hash.digest("hex") };
}

async function readInfoPlist(infoPlist: string): Promise<{ bundleVersion: string; shortVersion: string; executable: string } | null> {
  const stdout = await new Promise<string | null>((resolve) => {
    execFile(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", infoPlist],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 },
      (error, out) => resolve(error ? null : out),
    );
  });
  if (stdout === null) return null;
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const bundleVersion = parsed.CFBundleVersion;
    const shortVersion = parsed.CFBundleShortVersionString;
    const executable = parsed.CFBundleExecutable;
    if (
      typeof bundleVersion !== "string" || !bundleVersion
      || typeof shortVersion !== "string" || !shortVersion
      || typeof executable !== "string" || !/^[A-Za-z0-9 ._-]+$/.test(executable) || executable.startsWith(".")
    ) return null;
    return { bundleVersion, shortVersion, executable };
  } catch {
    return null;
  }
}

/**
 * Current identity of an installed official bundle, or null when any part
 * cannot be established (then the caller must run the full gate). `bundlePath`
 * must already be the realpath the full gate verifies.
 */
export async function computeMacBundleIdentity(input: {
  bundlePath: string;
  policyPath: string;
  runCommand?: MacTrustCommandRunner;
}): Promise<MacBundleIdentity | null> {
  try {
    const bundleRealpath = fs.realpathSync(input.bundlePath);
    if (bundleRealpath !== path.resolve(input.bundlePath)) return null;
    const contents = path.join(bundleRealpath, "Contents");
    const infoPlistPath = path.join(contents, "Info.plist");
    const infoPlist = fileIdentity(infoPlistPath);
    const codeResources = fileIdentity(path.join(contents, "_CodeSignature", "CodeResources"));
    if (!infoPlist || !codeResources) return null;
    const info = await readInfoPlist(infoPlistPath);
    if (!info) return null;
    const mainExecutable = fileIdentity(path.join(contents, "MacOS", info.executable));
    if (!mainExecutable) return null;
    const policyBytes = fs.readFileSync(input.policyPath);
    const policy = readMacReleaseSigningPolicy(input.policyPath);
    if (!policy) return null;
    const signed = await readMacInstalledAppSignedIdentity({
      bundlePath: bundleRealpath,
      policy,
      runCommand: input.runCommand,
    });
    if (!signed.ok || !signed.cdhash) return null;
    // Walk last so the digest reflects the tree as of the newest read.
    const tree = macBundleTreeDigest(bundleRealpath);
    if (!tree) return null;
    return {
      bundleRealpath,
      bundleVersion: info.bundleVersion,
      shortVersion: info.shortVersion,
      cdhash: signed.cdhash,
      codeResources,
      mainExecutable,
      infoPlist,
      policySha256: createHash("sha256").update(policyBytes).digest("hex"),
      osRelease: os.release(),
      osVersion: typeof os.version === "function" ? os.version() : "",
      tree,
    };
  } catch {
    return null;
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

const IDENTITY_KEYS: Array<keyof MacBundleIdentity> = [
  "bundleRealpath", "bundleVersion", "shortVersion", "cdhash", "codeResources", "mainExecutable",
  "infoPlist", "policySha256", "osRelease", "osVersion", "tree",
];

export function sameMacBundleIdentity(left: MacBundleIdentity, right: MacBundleIdentity): boolean {
  return canonical(left) === canonical(right);
}

function readRecord(cachePath: string, now: number): CacheRecord | null {
  try {
    const stat = fs.lstatSync(cachePath);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.nlink !== 1
      || stat.size > MAX_RECORD_BYTES
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o022) !== 0
    ) return null;
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Partial<CacheRecord>;
    if (
      !raw
      || typeof raw !== "object"
      || raw.schema !== MAC_RUNTIME_TRUST_CACHE_SCHEMA
      || typeof raw.recordedAt !== "number"
      || !Number.isFinite(raw.recordedAt)
      || raw.recordedAt > now + 5 * 60_000
      || now - raw.recordedAt > MAC_RUNTIME_TRUST_CACHE_MAX_AGE_MS
      || !raw.identity
      || typeof raw.identity !== "object"
      || canonical(Object.keys(raw.identity).sort()) !== canonical([...IDENTITY_KEYS].sort())
    ) return null;
    return raw as CacheRecord;
  } catch {
    return null;
  }
}

/** True only for a fresh, well-formed PASS whose identity equals `current`. */
export function macRuntimeTrustCacheHit(cachePath: string, current: MacBundleIdentity, now = Date.now()): boolean {
  const record = readRecord(cachePath, now);
  return record !== null && sameMacBundleIdentity(record.identity, current);
}

export function clearMacRuntimeTrustCache(cachePath: string): void {
  try {
    const stat = fs.lstatSync(cachePath);
    if (stat.isFile() || stat.isSymbolicLink()) fs.unlinkSync(cachePath);
  } catch {
    // Absent is the goal.
  }
}

/** Record a PASS. Callers must only pass an identity that was stable across the full gate. */
export function recordMacRuntimeTrustPass(cachePath: string, identity: MacBundleIdentity, now = Date.now()): boolean {
  const directory = path.dirname(cachePath);
  const temporary = `${cachePath}.${process.pid}.${now}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const record: CacheRecord = { schema: MAC_RUNTIME_TRUST_CACHE_SCHEMA, recordedAt: now, identity };
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, cachePath);
    return true;
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* never created */ }
    return false;
  }
}
