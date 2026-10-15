/*
 * Retained originals of host-authored request blocks (docs/2026-10-13-native-harness/20 §5.8, notyet NH18).
 *
 * The model-call ledger keeps sizes and digests only. The context inspector, though, must answer "what exactly did that
 * past request carry", not re-render today's settings in its place. So the host-authored blocks of each request
 * (instructions, tools, host context) are kept here, content-addressed by the ledger's own block digest
 * (sha256, 16 hex). Conversation history, attachments and tool results are not copied: they already live in their own
 * stores. The owner's text has no digest by design (short, guessable) and lives in the chat rows.
 *
 * Write-once per digest, local userData only, read back only when the text still hashes to its digest. No electron
 * import (the daemon and the SDK record and read the same store).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { userDataPath } from "../runtime-paths";

/** Ledger blocks whose original is retained (host-authored). */
export const RETAINED_CONTEXT_BLOCKS: readonly string[] = ["instructions", "tools", "hostContext"];
const MAX_BYTES = 2 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{16}$/;

const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

function fileFor(digest: string): string {
  return path.join(userDataPath("context-originals"), digest.slice(0, 2), `${digest}.txt`);
}

/** Keep `text` under `digest` once. Returns true when the original is (now) retained. Never throws. */
export function retainContextOriginal(digest: string | undefined, text: string | null | undefined): boolean {
  try {
    if (!digest || !DIGEST.test(digest) || typeof text !== "string" || !text) return false;
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES || digestOf(text) !== digest) return false;
    const file = fileFor(digest);
    if (fs.existsSync(file)) return true;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { fs.renameSync(tmp, file); } catch { try { fs.unlinkSync(tmp); } catch { /* another writer won */ } }
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

interface OpenOriginal { fd: number; file: string; parents: Array<[string, fs.BigIntStats]>; stat: fs.BigIntStats }
const sameObject = (a: fs.BigIntStats, b: fs.BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;

/** Resolve the owned root once, then reject symlinked store/shard/leaf paths before any content read. */
function openOriginal(digest: string | undefined): OpenOriginal | null {
  let fd: number | undefined;
  try {
    if (!digest || !DIGEST.test(digest)) return null;
    const root = path.join(fs.realpathSync(userDataPath()), "context-originals");
    const shard = path.join(root, digest.slice(0, 2));
    const parents: Array<[string, fs.BigIntStats]> = [];
    for (const directory of [root, shard]) {
      const stat = fs.lstatSync(directory, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(directory) !== directory) return null;
      parents.push([directory, stat]);
    }
    const file = path.join(shard, `${digest}.txt`);
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > BigInt(MAX_BYTES) || fs.realpathSync(file) !== file) return null;
    // POSIX has O_NOFOLLOW. Other hosts still verify the opened descriptor and every path before reading;
    // those checks are a portable fallback, not a claim of native Windows race acceptance.
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = { fd, file, parents, stat };
    if (!originalStillCurrent(opened)) { fs.closeSync(fd); return null; }
    return opened;
  } catch { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* retain original error semantics */ } return null; }
}

function originalStillCurrent(opened: OpenOriginal): boolean {
  try {
    for (const [directory, before] of opened.parents) {
      const current = fs.lstatSync(directory, { bigint: true });
      if (current.isSymbolicLink() || !current.isDirectory() || !sameObject(before, current)
        || fs.realpathSync(directory) !== directory) return false;
    }
    const leaf = fs.lstatSync(opened.file, { bigint: true });
    const descriptor = fs.fstatSync(opened.fd, { bigint: true });
    return !leaf.isSymbolicLink() && leaf.isFile() && fs.realpathSync(opened.file) === opened.file
      && descriptor.isFile() && sameObject(opened.stat, leaf) && sameObject(opened.stat, descriptor)
      && descriptor.size === opened.stat.size && descriptor.mtimeNs === opened.stat.mtimeNs && descriptor.ctimeNs === opened.stat.ctimeNs;
  } catch { return false; }
}

/** The exact retained original, or null for missing, escaped, replaced or modified bytes. Never throws. */
export function readContextOriginal(digest: string | undefined): string | null {
  const opened = openOriginal(digest);
  if (!opened) return null;
  try {
    const text = fs.readFileSync(opened.fd, "utf8");
    return originalStillCurrent(opened) && BigInt(Buffer.byteLength(text, "utf8")) === opened.stat.size
      && digestOf(text) === digest ? text : null;
  } catch { return null; }
  finally { try { fs.closeSync(opened.fd); } catch { /* read remains best effort */ } }
}

/** A regular original exists in the owned store; contents are verified only when requested. */
export function hasContextOriginal(digest: string | undefined): boolean {
  const opened = openOriginal(digest);
  if (!opened) return false;
  try { fs.closeSync(opened.fd); } catch { return false; }
  return true;
}
