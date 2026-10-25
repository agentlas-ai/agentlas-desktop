// How an entry of a product-home mirror stands for the person's own entry (codex, claude, grok, kimi, copilot mirrors).
//
// macOS / Linux: a symlink, exactly as before.
// Windows: a folder is a junction (no privilege needed). A file is a symlink only when the account may make one
// (Developer Mode or elevated); a default Windows account may not (EPERM), and until 2026-10-24 that made every mirror
// report "links-unavailable" and every product run of codex/claude/grok/kimi/copilot start in the person's own folder,
// with their instructions, MCP servers, hooks and plugins (Windows audit 2026-10-24 fs.md #1, runtimes.md W-03: the same
// class as the codex OAuth-MCP incident). So a file falls back to a hard link (same volume, no privilege), then to a
// copy (another volume; at most MAX_COPY_BYTES).
//
// A hard link or copy is not a link the CLI writes through for sure: a CLI that replaces a file by rename leaves the
// person's file behind, and a copy never shares writes. Each one is recorded in the mirror's MIRROR_LINK_RECORD with
// the content digest both sides had when they were last made equal, and every sync (reconcileMirrorLinks) makes it
// behave like the link it stands for:
//   - the side that changed since then wins: a token the CLI refreshed in the mirror reaches the person's file (as it
//     would through a symlink), a change of the person's reaches the mirror;
//   - both changed: the newer file wins;
//   - then the two are one file again (hard link) or equal (copy).
// Nothing is recorded on macOS / Linux, so there every function here is the old behaviour.
//
// A mirror that still cannot hold is never silent: callers report it with reportIsolationUnavailable.
//
// A copy is a new file, and a new Windows file takes the ACL of the folder it lands in. In the default %APPDATA% that is
// the account, SYSTEM and Administrators only; with userData moved to another drive it is that drive's ACL, which on a
// data drive usually lets every signed-in account read (and the copy may be a sign-in token). So a copy is made inside a
// fresh staging folder first narrowed to the current account alone (icacls: inheritance removed, one grant to the
// account's SID, inherited by files), which a file created there takes at creation, then renamed into place (a rename on
// one volume keeps the file's ACL). When the folder cannot be narrowed (no icacls or whoami, FAT/exFAT, refused) there is
// no copy: the entry is null, reported once as product_home_copy_refused, and callers that need it report
// product_home_isolation_unavailable as for any entry that cannot be linked.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The mirror's record of its hard links and copies (Windows only). Never linked from the person's folder. */
export const MIRROR_LINK_RECORD = ".agentlas-mirror-links.json";
/** A file larger than this is not copied when it cannot be linked (a live database, a log); the CLI keeps its own. */
export const MAX_MIRROR_COPY_BYTES = 8 * 1024 * 1024;

export type MirrorLinkKind = "symlink" | "junction" | "hardlink" | "copy";

/** `narrowed`: a copy made readable by the current account only (an entry without it is copied again at the next sync). */
interface RecordEntry { target: string; kind: "hardlink" | "copy"; digest: string; narrowed?: true }
interface LinkRecord { version: 1; entries: Record<string, RecordEntry> }

const errorCode = (error: unknown): string => String((error as NodeJS.ErrnoException | null)?.code ?? "unknown");

function onWindows(): boolean {
  return process.platform === "win32";
}

function lstatOrNull(at: string): fs.BigIntStats | null {
  try { return fs.lstatSync(at, { bigint: true }); } catch { return null; }
}
function statOrNull(at: string): fs.BigIntStats | null {
  try { return fs.statSync(at, { bigint: true }); } catch { return null; }
}
function sameFile(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
}
function digestFile(file: string): string | null {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}

function readRecord(dir: string): LinkRecord {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MIRROR_LINK_RECORD), "utf8")) as Partial<LinkRecord>;
    if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") return { version: 1, entries: {} };
    const entries: Record<string, RecordEntry> = {};
    for (const [name, entry] of Object.entries(parsed.entries)) {
      if (!entry || typeof entry.target !== "string" || !path.isAbsolute(entry.target) || (entry.kind !== "hardlink" && entry.kind !== "copy")
        || typeof entry.digest !== "string" || name.includes("/") || name.includes("\\")) continue;
      entries[name] = { target: entry.target, kind: entry.kind, digest: entry.digest, ...(entry.kind === "copy" && entry.narrowed === true ? { narrowed: true as const } : {}) };
    }
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeRecord(dir: string, record: LinkRecord): void {
  const at = path.join(dir, MIRROR_LINK_RECORD);
  if (Object.keys(record.entries).length === 0) {
    try { fs.rmSync(at, { force: true }); } catch { /* raced */ }
    return;
  }
  const tmp = `${at}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, at);
}

/** Read-modify-write of one entry (two runs may sync the same mirror). */
function updateRecord(dir: string, name: string, entry: RecordEntry | null): void {
  const record = readRecord(dir);
  if (entry) record.entries[name] = entry;
  else if (name in record.entries) delete record.entries[name];
  else return;
  writeRecord(dir, record);
}

/** Makes `at` (absent) stand for `target`, without recording. null: a file that could not be linked or copied. */
function makeLink(target: string, at: string): MirrorLinkKind | null {
  if (!onWindows()) { fs.symlinkSync(target, at); return "symlink"; }
  const stat = statOrNull(target);
  if (stat?.isDirectory()) { fs.symlinkSync(target, at, "junction"); return "junction"; }
  try { fs.symlinkSync(target, at, "file"); return "symlink"; }
  catch (error) { if (errorCode(error) === "EEXIST") throw error; }
  if (!stat) return null; // dangling: nothing to link to
  try { fs.linkSync(target, at); return "hardlink"; }
  catch (error) { if (errorCode(error) === "EEXIST") throw error; }
  if (stat.size > BigInt(MAX_MIRROR_COPY_BYTES)) return null;
  return copyForCurrentAccount(target, at) ? "copy" : null;
}

const SYSTEM32 = (): string => path.win32.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32");
let accountSid: string | null = null;

/** The current account's SID (`whoami /user`, CSV: the last field), cached once read; null when it cannot be read. */
function currentAccountSid(): string | null {
  if (accountSid) return accountSid;
  try {
    const out = execFileSync(path.win32.join(SYSTEM32(), "whoami.exe"), ["/user", "/fo", "csv", "/nh"],
      { encoding: "latin1", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    const sid = /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(String(out).trim())?.[1] ?? null;
    if (sid) accountSid = sid;
    return sid;
  } catch {
    return null;
  }
}

/** Leaves folder `dir` (empty) readable by the current account only, and every file later made in it. */
function narrowFolderToCurrentAccount(dir: string): string | null {
  const sid = currentAccountSid();
  if (!sid) return "account-sid-unavailable";
  try {
    execFileSync(path.win32.join(SYSTEM32(), "icacls.exe"), [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "/q"],
      { windowsHide: true, timeout: 10_000, stdio: "ignore" });
    return null;
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    return typeof status === "number" ? `icacls-exit-${status}` : `icacls-${errorCode(error)}`;
  }
}

const reportedCopy = new Set<string>();

/**
 * Windows: copies `target` to the absent `at` so only the current account can read the copy (see the file comment).
 * False (nothing left behind) when that cannot be made sure; throws EEXIST when `at` already exists.
 */
function copyForCurrentAccount(target: string, at: string): boolean {
  const dir = path.dirname(at);
  let staging: string | null = null;
  let refused: string | null = null;
  try {
    staging = fs.mkdtempSync(path.join(dir, ".agentlas-copy-"));
    refused = narrowFolderToCurrentAccount(staging);
    if (refused) return false;
    const staged = path.join(staging, "entry");
    fs.writeFileSync(staged, fs.readFileSync(target), { flag: "wx", mode: 0o600 });
    if (lstatOrNull(at)) throw Object.assign(new Error(`EEXIST: ${at}`), { code: "EEXIST" });
    fs.renameSync(staged, at);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST" && lstatOrNull(at)) throw error;
    refused = `copy-${errorCode(error)}`;
    return false;
  } finally {
    if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ } }
    if (refused) {
      const entry = path.basename(at).replace(/^\.(.+)\.agentlas-link-\d+\.tmp$/, "$1"); // a reconcile's temp name
      const key = `${entry}\0${refused}`;
      if (!reportedCopy.has(key)) {
        reportedCopy.add(key);
        console.warn("[product-home]", JSON.stringify({ code: "product_home_copy_refused", entry, cause: refused, platform: process.platform }));
      }
    }
  }
}

function recordFor(target: string, kind: "hardlink" | "copy"): RecordEntry {
  return { target, kind, digest: digestFile(target) ?? "", ...(kind === "copy" ? { narrowed: true as const } : {}) };
}

/**
 * Makes the absent mirror entry `at` stand for `target` (see the file comment). Throws EEXIST when something is already
 * there and whatever made a folder link fail; returns null for a file that could not be linked or copied (callers check
 * the sign-in entries they need with mirrorEntryLinked).
 */
export function linkMirrorEntry(target: string, at: string): MirrorLinkKind | null {
  const kind = makeLink(target, at);
  if (kind === "hardlink" || kind === "copy") {
    updateRecord(path.dirname(at), path.basename(at), recordFor(target, kind));
  }
  return kind;
}

/** The recorded hard link / copy entry `name` of `dir`, if any. */
function recorded(dir: string, name: string): RecordEntry | null {
  return readRecord(dir).entries[name] ?? null;
}

/**
 * What mirror entry `dir/name` stands for: a symlink's target as written, or a recorded hard link / copy's target; null
 * for anything else (absent, or a file the CLI made in the mirror).
 */
export function mirrorEntryTarget(dir: string, name: string): string | null {
  const at = path.join(dir, name);
  const stat = lstatOrNull(at);
  if (!stat) return null;
  if (stat.isSymbolicLink()) { try { return fs.readlinkSync(at); } catch { return null; } }
  if (!stat.isFile()) return null;
  return recorded(dir, name)?.target ?? null;
}

/** True when `dir/name` stands for `target` (or, without `target`, for anything): a symlink or a recorded hard link / copy. */
export function mirrorEntryLinked(dir: string, name: string, target?: string): boolean {
  const linked = mirrorEntryTarget(dir, name);
  return linked !== null && (target === undefined || linked === target);
}

/** True when `dir/name` is a hard link or copy this module made (the caller then treats it as a link, not a CLI file). */
export function isRecordedMirrorEntry(dir: string, name: string): boolean {
  return !lstatOrNull(path.join(dir, name))?.isSymbolicLink() && recorded(dir, name) !== null;
}

/**
 * A plain file at a wanted name that is one file with the person's (a hard link whose record two concurrent syncs lost):
 * recorded again so it is reconciled like any other. Windows only; false elsewhere.
 */
export function adoptMirrorHardLink(dir: string, name: string, target: string): boolean {
  if (!onWindows()) return false;
  const at = path.join(dir, name);
  const mine = lstatOrNull(at), theirs = statOrNull(target);
  if (!mine?.isFile() || !theirs?.isFile() || !sameFile(mine, theirs)) return false;
  updateRecord(dir, name, { target, kind: "hardlink", digest: digestFile(target) ?? "" });
  return true;
}

/** Removes mirror entry `name` (a link of any kind: only the mirror's name goes, never the person's file) and its record. */
export function unlinkMirrorEntry(dir: string, name: string): void {
  try { fs.unlinkSync(path.join(dir, name)); }
  catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  updateRecord(dir, name, null);
}

/** Writes the person's file: temp file + rename, or in place when the rename is refused (the file is open on Windows). */
function writePersonFile(target: string, data: Buffer): void {
  const tmp = `${target}.agentlas-${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    if (!["EPERM", "EACCES", "EBUSY"].includes(errorCode(error))) throw error;
    fs.writeFileSync(target, data);
  }
}

const reportedReconcile = new Set<string>();

/**
 * Brings every recorded hard link / copy of `dir` back in line with the person's file (see the file comment). `wanted`
 * maps each name the mirror should link to its target: a recorded entry not wanted (or wanted for another target) is
 * unlinked, so the caller can make it again or write its own file there. No record (macOS, Linux, a symlink mirror): no-op.
 */
export function reconcileMirrorLinks(dir: string, wanted: ReadonlyMap<string, string>): void {
  const names = Object.keys(readRecord(dir).entries);
  for (const name of names) {
    const entry = recorded(dir, name);
    if (!entry) continue;
    const at = path.join(dir, name);
    try {
      if (wanted.get(name) !== entry.target) { unlinkMirrorEntry(dir, name); continue; }
      const mine = lstatOrNull(at);
      if (!mine) { updateRecord(dir, name, null); continue; } // gone: the caller links it again
      if (!mine.isFile()) { updateRecord(dir, name, null); continue; } // replaced by the CLI: its own now
      const theirs = statOrNull(entry.target);
      if (!theirs?.isFile()) { unlinkMirrorEntry(dir, name); continue; } // the person removed it: a link would dangle
      if (entry.kind === "hardlink" && sameFile(mine, theirs)) {
        const digest = digestFile(at);
        if (digest !== null && digest !== entry.digest) updateRecord(dir, name, { ...entry, digest });
        continue;
      }
      const mineDigest = digestFile(at), theirDigest = digestFile(entry.target);
      if (mineDigest === null || theirDigest === null) continue; // unreadable now: try again next sync
      // An equal copy already narrowed to the account stays as it is (each copy costs an icacls run); an older copy
      // without `narrowed` is made again below, so it gets the narrowed ACL too.
      if (entry.kind === "copy" && entry.narrowed && mineDigest === theirDigest) {
        if (mineDigest !== entry.digest) updateRecord(dir, name, { ...entry, digest: mineDigest });
        continue;
      }
      if (mineDigest !== theirDigest) {
        const mirrorChanged = mineDigest !== entry.digest, personChanged = theirDigest !== entry.digest;
        if (mirrorChanged && (!personChanged || mine.mtimeMs > theirs.mtimeMs)) writePersonFile(entry.target, fs.readFileSync(at));
      }
      // One file (or equal copies) again: made beside the entry, then renamed over it, so a reader never sees it absent.
      const tmp = path.join(dir, `.${name}.agentlas-link-${process.pid}.tmp`);
      try { fs.unlinkSync(tmp); } catch { /* none */ }
      const kind = makeLink(entry.target, tmp);
      if (kind === null) continue; // keep the entry as it is; the next sync tries again
      fs.renameSync(tmp, at);
      updateRecord(dir, name, kind === "hardlink" || kind === "copy" ? recordFor(entry.target, kind) : null);
    } catch (error) {
      const key = `${name}\0${errorCode(error)}`;
      if (!reportedReconcile.has(key)) {
        reportedReconcile.add(key);
        console.warn("[product-home]", JSON.stringify({ code: "product_home_link_reconcile_failed", entry: name, cause: errorCode(error) }));
      }
    }
  }
}

const reportedIsolation = new Set<string>();

/**
 * A product home that could not be built for a reason other than the person's own setup (no folder, keyring sign-in):
 * typed, once per runtime and cause, never silent. The run continues with the person's folder (owner principle: a
 * runtime is not refused for this; the policy question stays open).
 */
export function reportIsolationUnavailable(runtime: string, cause: unknown): void {
  const reason = typeof cause === "string" ? cause : errorCode(cause);
  const key = `${runtime}\0${reason}`;
  if (reportedIsolation.has(key)) return;
  reportedIsolation.add(key);
  console.warn("[product-home]", JSON.stringify({ code: "product_home_isolation_unavailable", runtime, cause: reason, platform: process.platform }));
}
