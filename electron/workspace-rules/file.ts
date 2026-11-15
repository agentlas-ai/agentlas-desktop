import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/*
 * The owner's rules file, READ side only (Agentlas 2.0 P3a; and 5.5). Writing, the IPC and the pick list are P4's and will sit on top of this file.
 *
 *   readWorkspaceRules(file, limits)  ->  { state, text, fingerprint, bytes, loadedBytes, overflow }
 *
 * The file is `<memory owner folder>/WORKSPACE.md` (the caller resolves the path). Every outcome is a value, never an exception: a rules file that is missing, empty, binary, a link,
 * 10 MB, unreadable or edited while it is read must never stop a turn. The five states:
 *
 *   missing           no such file (ENOENT / ENOTDIR): the turn carries no rules piece
 *   empty             the file is there and holds nothing but whitespace and closed block comments: the piece says `(none)` so a resumed session stops following a rule the owner deleted
 *   ok                `text` is what loads: the text without closed block comments, cut at a line boundary to `limits.loadMaxBytes`
 *   rules_unreadable  a link, a directory, a device or pipe, a file that refuses to open, binary data (a NUL in the first 8 KiB of a non-UTF-16 file) or anything that changed to one of these
 *                     between the look and the read: never followed, no rules piece
 *
 * What is read: only a regular file (lstat, then open without following links and a second look at the opened file), only its first `limits.readMaxBytes` bytes (a 10 MB file costs what
 * a 64 KiB one does). UTF-8 BOM is removed, a UTF-16 BOM selects that reading, broken UTF-8 becomes replacement characters, `\r\n` and `\r` become `\n`. A comment is removed only when it is a
 * closed `<!-- ... -->` outside a fenced code block; an unclosed `<!--` is text.
 *
 * THE WRITE SIDE: this file is the ONLY place that creates, replaces or removes the rules file. It is reached from the owner's own IPC calls (save, clear, addPicked) and
 * from nowhere else: no agent, tool, hook, migration step or timer calls it. See "write side" below.
 *
 * Change detection is the file's own `size`, `mtimeMs`, `ctimeMs` and `ino`: when all four match the last look, the text kept from it is used (one kept text per file path; no timer, no watcher).
 * No absolute path and no header of any kind is part of what this returns for the model.
 */

export interface RulesReadLimits { loadMaxBytes: number; readMaxBytes: number }
export type WorkspaceRulesFileState = "missing" | "empty" | "ok" | "rules_unreadable";
export interface WorkspaceRulesRead {
  state: WorkspaceRulesFileState;
  /** The text that loads (comments removed, cut to the load cap); "" unless state is "ok". */
  text: string;
  /** sha256 hex of `text`; "" unless state is "ok". */
  fingerprint: string;
  /** Bytes of the stripped text before the load cap. */
  bytes: number;
  loadedBytes: number;
  /** Lines of the stripped text that the load cap left out. */
  overflowLines: number;
}

const NUL_WINDOW = 8 * 1024;
const kept = new Map<string, { key: string; limits: string; read: WorkspaceRulesRead }>();
const KEPT_MAX = 8;
const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
const O_NONBLOCK = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;

const result = (state: WorkspaceRulesFileState, text = "", bytes = 0, overflowLines = 0): WorkspaceRulesRead =>
  ({ state, text, fingerprint: text ? createHash("sha256").update(text, "utf8").digest("hex") : "", bytes, loadedBytes: Buffer.byteLength(text, "utf8"), overflowLines });

/** The characters of a buffer, by its byte-order mark. null = a NUL byte in a file that is not UTF-16 (binary). */
export function decodeRulesBytes(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString("utf8");
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2, 2 + ((buffer.length - 2) & ~1)).toString("utf16le");
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const even = buffer.subarray(2, 2 + ((buffer.length - 2) & ~1));
    return Buffer.from(even).swap16().toString("utf16le");
  }
  if (buffer.subarray(0, NUL_WINDOW).includes(0)) return null;
  return buffer.toString("utf8");
}

/** `\r\n` and `\r` to `\n`. */
export function normalizeLineEnds(text: string): string { return text.replace(/\r\n?/g, "\n"); }

/**
 * Removes closed `<!-- ... -->` comments outside fenced code blocks (``` or ~~~). A comment may span lines and swallows whatever is inside it; an unclosed `<!--` stays as text.
 * The line a comment leaves behind keeps its other text (or becomes an empty line).
 */
export function stripBlockComments(text: string): string {
  let out = "";
  let i = 0;
  let fence: { char: string; length: number } | null = null;
  while (i < text.length) {
    const lineEndAt = text.indexOf("\n", i);
    const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
    const newline = lineEndAt < 0 ? "" : "\n";
    if (i === 0 || text[i - 1] === "\n") {
      const line = text.slice(i, lineEnd);
      if (fence) {
        const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
        if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) fence = null;
        out += line + newline; i = lineEnd + 1; continue;
      }
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (opening) { fence = { char: opening[1][0], length: opening[1].length }; out += line + newline; i = lineEnd + 1; continue; }
    }
    const start = text.indexOf("<!--", i);
    if (start >= 0 && start < lineEnd) {
      const close = text.indexOf("-->", start + 4);
      if (close >= 0) { out += text.slice(i, start); i = close + 3; continue; }
    }
    out += text.slice(i, lineEnd) + newline; i = lineEnd + 1;
  }
  return out;
}

/** The leading part of `text` that fits `maxBytes` of UTF-8, cut at a line boundary (a first line longer than the cap is cut at a character boundary). */
export function cutAtLineBoundary(text: string, maxBytes: number): { text: string; overflowLines: number } {
  if (maxBytes <= 0) return { text: "", overflowLines: text.split("\n").length };
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, overflowLines: 0 };
  const lines = text.split("\n");
  let used = 0;
  const taken: string[] = [];
  for (const line of lines) {
    const size = Buffer.byteLength(line, "utf8") + (taken.length ? 1 : 0);
    if (used + size > maxBytes) break;
    taken.push(line); used += size;
  }
  if (!taken.length) {
    // The first line alone is over the cap: a character boundary, never half of a code point.
    let cut = "";
    let bytes = 0;
    for (const char of lines[0]) { const n = Buffer.byteLength(char, "utf8"); if (bytes + n > maxBytes) break; cut += char; bytes += n; }
    return { text: cut, overflowLines: lines.length - 1 };
  }
  return { text: taken.join("\n"), overflowLines: lines.length - taken.length };
}

function readFileOnce(file: string, limits: RulesReadLimits): { read: WorkspaceRulesRead; key: string } {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { read: result(code === "ENOENT" || code === "ENOTDIR" ? "missing" : "rules_unreadable"), key: "" };
  }
  if (!stat.isFile()) return { read: result("rules_unreadable"), key: "" };
  const key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    // The file we opened must be the file we looked at (a swap for a link or a pipe between the two looks is refused).
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) return { read: result("rules_unreadable"), key: "" };
    const want = Math.min(Math.max(0, limits.readMaxBytes), opened.size);
    const buffer = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = fs.readSync(fd, buffer, got, want - got, got);
      if (n <= 0) break;
      got += n;
    }
    const decoded = decodeRulesBytes(buffer.subarray(0, got));
    if (decoded === null) return { read: result("rules_unreadable"), key };
    const stripped = stripBlockComments(normalizeLineEnds(decoded));
    if (!stripped.trim()) return { read: result("empty"), key };
    const bytes = Buffer.byteLength(stripped, "utf8");
    const cut = cutAtLineBoundary(stripped.replace(/^\n+/, "").replace(/\s+$/, ""), limits.loadMaxBytes);
    if (!cut.text.trim()) return { read: result("empty", "", bytes), key };
    return { read: result("ok", cut.text, bytes, cut.overflowLines), key };
  } catch {
    return { read: result("rules_unreadable"), key: "" };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
}

/** Reads the rules file (see the header). Never throws. The kept text is reused when the file's size, mtime, ctime and inode and the limits are what they were. */
export function readWorkspaceRules(file: string, limits: RulesReadLimits): WorkspaceRulesRead {
  try {
    const limitKey = `${limits.loadMaxBytes}:${limits.readMaxBytes}`;
    let before: fs.Stats | null = null;
    try { before = fs.lstatSync(file); } catch { /* the full read below names the state */ }
    if (before && before.isFile()) {
      const key = `${before.size}:${before.mtimeMs}:${before.ctimeMs}:${before.ino}`;
      const hit = kept.get(file);
      if (hit && hit.key === key && hit.limits === limitKey) return hit.read;
    }
    const { read, key } = readFileOnce(file, limits);
    if (key && read.state !== "rules_unreadable") {
      // The text is kept only when the file did not change while it was read.
      let after: fs.Stats | null = null;
      try { after = fs.lstatSync(file); } catch { /* gone: do not keep */ }
      if (after && `${after.size}:${after.mtimeMs}:${after.ctimeMs}:${after.ino}` === key) {
        if (kept.size >= KEPT_MAX && !kept.has(file)) kept.delete(kept.keys().next().value as string);
        kept.set(file, { key, limits: limitKey, read });
      } else kept.delete(file);
    } else kept.delete(file);
    return read;
  } catch {
    return result("rules_unreadable");
  }
}

/** For tests and the account switch: forget what was kept. */
export function forgetKeptWorkspaceRules(): void { kept.clear(); }

/* ============================================================== write side (P4) ============================================================== */

/** The most the editor reads or writes: 256 KiB. A rules file is a few lines; a larger one is shown as "too large to edit" (it can still be cleared). */
export const RULES_EDIT_MAX_BYTES = 256 * 1024;
export type RulesWriteCode = "rules_changed" | "rules_readonly" | "rules_disk_full" | "rules_busy" | "rules_unreadable" | "rules_full";

/**
 * What the editor sees of the file, one look. `kind`:
 *   missing  no such file
 *   text     a regular file read in full as text (<= RULES_EDIT_MAX_BYTES, no NUL unless UTF-16)
 *   opaque   a regular file that is binary, larger than the edit cap or refuses to open: it can be cleared (replaced by an empty file), never edited
 *   unsafe   a link, a directory, a device or pipe, or anything else: never followed, never replaced
 * `fingerprint` is sha256 over the owner key and the content (or, for `opaque`, size, mtime, ctime and inode): the owner key makes one owner's value useless for another owner's file.
 */
export interface RulesFileLook { kind: "missing" | "text" | "opaque" | "unsafe"; text: string; fingerprint: string;
  /** Desktop repair 6: `opaque` because the system REFUSED the open with a permission error (EACCES / EPERM: a Windows ACL that denies the file, a POSIX mode without read), not because of what the file holds. A save over it is `rules_readonly` (the file is not the owner's to write), not `rules_unreadable`. */
  refused?: true }

const fingerprintOf = (ownerKey: string, tag: string, body: Buffer | string): string =>
  createHash("sha256").update(ownerKey, "utf8").update("\0").update(tag).update("\0").update(body).digest("hex");

export function lookAtRulesFile(file: string, ownerKey: string): RulesFileLook {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing", text: "", fingerprint: fingerprintOf(ownerKey, "missing", "") } : { kind: "unsafe", text: "", fingerprint: fingerprintOf(ownerKey, "unsafe", String(code)) };
  }
  if (!stat.isFile()) return { kind: "unsafe", text: "", fingerprint: fingerprintOf(ownerKey, "unsafe", `${stat.mode}:${stat.ino}`) };
  const opaque = (): RulesFileLook => ({ kind: "opaque", text: "", fingerprint: fingerprintOf(ownerKey, "opaque", `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`) });
  if (stat.size > RULES_EDIT_MAX_BYTES) return opaque();
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) return { kind: "unsafe", text: "", fingerprint: fingerprintOf(ownerKey, "unsafe", "swapped") };
    const want = Math.min(opened.size, RULES_EDIT_MAX_BYTES);
    const buffer = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = fs.readSync(fd, buffer, got, want - got, got);
      if (n <= 0) break;
      got += n;
    }
    const bytes = buffer.subarray(0, got);
    const decoded = decodeRulesBytes(bytes);
    if (decoded === null) return opaque();
    return { kind: "text", text: normalizeLineEnds(decoded), fingerprint: fingerprintOf(ownerKey, "file", bytes) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A link or special file swapped in between the two looks is not ours to touch; a plain refusal to open (permissions) is a regular file we can only replace.
    if (code === "ELOOP" || code === "ENXIO" || code === "EISDIR") return { kind: "unsafe", text: "", fingerprint: fingerprintOf(ownerKey, "unsafe", String(code)) };
    return code === "EACCES" || code === "EPERM" ? { ...opaque(), refused: true } : opaque();
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
}

/** What the loaded text of `text` would be and how many lines fall beyond the load cap: the same pipeline `readWorkspaceRules` runs (comments removed, trimmed, cut at a line boundary). */
export function rulesLoadView(text: string, loadMaxBytes: number): { strippedBytes: number; bodyBytes: number; overflowLines: number } {
  const stripped = stripBlockComments(normalizeLineEnds(text));
  if (!stripped.trim()) return { strippedBytes: 0, bodyBytes: 0, overflowLines: 0 };
  const body = stripped.replace(/^\n+/, "").replace(/\s+$/, "");
  // `strippedBytes` is what the reader reports as `bytes` (comments removed, not trimmed); `bodyBytes` is what is cut against the load cap.
  return { strippedBytes: Buffer.byteLength(stripped, "utf8"), bodyBytes: Buffer.byteLength(body, "utf8"), overflowLines: cutAtLineBoundary(body, loadMaxBytes).overflowLines };
}

/** The decision of one update: the text the file becomes, or a refusal code. */
export type RulesUpdate = { text: string } | { code: RulesWriteCode };
export type RulesUpdateResult = { ok: true; fingerprint: string; changed: boolean } | { ok: false; code: RulesWriteCode };

const TEMP_PREFIX = "WORKSPACE.md.tmp-";
let tempCounter = 0;
let chain: Promise<unknown> = Promise.resolve();
/** One write at a time in this process (the rules file has one writer, Main). A second window or a second call waits, then re-reads. */
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  chain = run.then(() => undefined, () => undefined);
  return run;
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const codeOfFsError = (error: unknown, fallback: RulesWriteCode = "rules_busy"): RulesWriteCode => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG") return "rules_disk_full";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "rules_readonly";
  return fallback;
};

/** Removes the temp files a crash left (this process's own name pattern, a pid that is gone). Never touches the rules file or any other name. Called once per folder per process, never on a timer. */
const swept = new Set<string>();
export function sweepRulesTemps(dir: string): number {
  if (swept.has(dir)) return 0;
  swept.add(dir);
  let removed = 0;
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    const match = /^WORKSPACE\.md\.tmp-(\d+)-(\d+)$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code === "EPERM"; }
    if (alive) continue;
    try { const target = path.join(dir, name); if (fs.lstatSync(target).isFile()) { fs.unlinkSync(target); removed += 1; } } catch { /* gone or not ours */ }
  }
  return removed;
}
/** For tests: forget which folders were swept. */
export function forgetSweptRulesFolders(): void { swept.clear(); }

/**
 * THE one writer. Reads the file under the process lock, refuses unless its fingerprint is `baseFingerprint` (`rules_changed`: someone else edited it, or it is another owner's value), asks `decide` what the
 * file becomes, writes that to a temp file in the same folder (mode 0600, fsync) and renames it over the file after a last look. Never follows a link, never replaces a directory or special file, never leaves a
 * temp file behind (a crash between the two leaves one that the next start removes), and a refusal leaves the file byte for byte as it was.
 *
 * `allowOpaque`: a regular file that is binary / too large / unreadable may be replaced (only `clear` says so).
 */
export function updateWorkspaceRules(file: string, ownerKey: string, baseFingerprint: unknown, decide: (look: RulesFileLook) => RulesUpdate, options: { allowOpaque?: boolean } = {}): Promise<RulesUpdateResult> {
  return exclusive(async (): Promise<RulesUpdateResult> => {
    const dir = path.dirname(file);
    const base = typeof baseFingerprint === "string" ? baseFingerprint : "";
    try {
      // The owner's folder: made when it is missing (an owner action), never a link or a file.
      let dirStat: fs.Stats | null = null;
      try { dirStat = fs.lstatSync(dir); } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code !== "ENOENT") return { ok: false, code: codeOfFsError(error, "rules_unreadable") }; }
      if (dirStat && (!dirStat.isDirectory() || dirStat.isSymbolicLink())) return { ok: false, code: "rules_unreadable" };
      const first = lookAtRulesFile(file, ownerKey);
      if (first.kind === "unsafe" || (first.kind === "opaque" && !options.allowOpaque)) return { ok: false, code: first.kind === "opaque" && first.refused ? "rules_readonly" : "rules_unreadable" };
      if (first.fingerprint !== base) return { ok: false, code: "rules_changed" };
      const decision = decide(first);
      if ("code" in decision) return { ok: false, code: decision.code };
      const bytes = Buffer.from(decision.text, "utf8");
      if (bytes.length > RULES_EDIT_MAX_BYTES) return { ok: false, code: "rules_full" };
      const resulting = fingerprintOf(ownerKey, "file", bytes);
      // Nothing to change: the same bytes (or clearing a file that is not there) is a success that touches nothing.
      if (first.kind === "text" && first.fingerprint === resulting) return { ok: true, fingerprint: resulting, changed: false };
      if (first.kind === "missing" && bytes.length === 0) return { ok: true, fingerprint: first.fingerprint, changed: false };
      if (!dirStat) {
        try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (error) { return { ok: false, code: codeOfFsError(error) }; }
      }
      // A read-only file or folder is the owner's own choice: refused with its own code, not worked around.
      if (first.kind !== "missing") { try { fs.accessSync(file, fs.constants.W_OK); } catch { return { ok: false, code: "rules_readonly" }; } }
      try { fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK); } catch { return { ok: false, code: "rules_readonly" }; }
      sweepRulesTemps(dir);
      const temp = path.join(dir, `${TEMP_PREFIX}${process.pid}-${++tempCounter}`);
      const dropTemp = (): void => { try { fs.unlinkSync(temp); } catch { /* not there */ } };
      let fd: number | null = null;
      try {
        fd = fs.openSync(temp, "wx", 0o600);
        let written = 0;
        while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written);
        try { fs.fsyncSync(fd); } catch { /* a filesystem without fsync still holds the data */ }
        fs.closeSync(fd); fd = null;
      } catch (error) {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
        dropTemp();
        return { ok: false, code: codeOfFsError(error) };
      }
      // The last look, right before the rename: an editor that saved since the first look wins, and our text is dropped rather than overwriting it.
      const second = lookAtRulesFile(file, ownerKey);
      if (second.kind === "unsafe" || (second.kind === "opaque" && !options.allowOpaque)) { dropTemp(); return { ok: false, code: second.kind === "opaque" && second.refused ? "rules_readonly" : "rules_unreadable" }; }
      if (second.fingerprint !== base) { dropTemp(); return { ok: false, code: "rules_changed" }; }
      let renamed = false;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 4 && !renamed; attempt += 1) {
        if (attempt > 0) await sleep(60 * attempt);
        try { fs.renameSync(temp, file); renamed = true; }
        catch (error) {
          lastError = error;
          const code = (error as NodeJS.ErrnoException).code;
          // Windows refuses a rename while a reader (a virus scanner, an editor) holds the file: three more tries, then busy. Elsewhere a permission error is final.
          if (!(process.platform === "win32" && (code === "EPERM" || code === "EBUSY" || code === "EACCES"))) break;
        }
      }
      // A file the system already refused to open for us (an ACL that denies it) is not "busy": the replace is refused for the same reason and waiting changes nothing (desktop repair 6).
      if (!renamed) { dropTemp(); return { ok: false, code: first.refused && ["EPERM", "EACCES"].includes((lastError as NodeJS.ErrnoException)?.code ?? "") ? "rules_readonly" : process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes((lastError as NodeJS.ErrnoException)?.code ?? "") ? "rules_busy" : codeOfFsError(lastError) }; }
      if (process.platform !== "win32") {
        let dirFd: number | null = null;
        try { dirFd = fs.openSync(dir, fs.constants.O_RDONLY); fs.fsyncSync(dirFd); } catch { /* best effort */ } finally { if (dirFd !== null) { try { fs.closeSync(dirFd); } catch { /* closed */ } } }
      }
      return { ok: true, fingerprint: resulting, changed: true };
    } catch (error) {
      return { ok: false, code: codeOfFsError(error) };
    }
  });
}

/** Save the whole text (the owner's edit). Line ends become `\n`, a NUL (which would make the file read as binary) is dropped, UTF-8 without a byte-order mark. */
export function saveWorkspaceRules(file: string, ownerKey: string, text: string, baseFingerprint: unknown): Promise<RulesUpdateResult> {
  const clean = normalizeLineEnds(text).replace(/\u0000/g, "");
  return updateWorkspaceRules(file, ownerKey, baseFingerprint, () => ({ text: clean }));
}

/** Clear: the file stays and becomes empty (a turn then says "(none)"); a file that is not there stays not there. */
export function clearWorkspaceRules(file: string, ownerKey: string, baseFingerprint: unknown): Promise<RulesUpdateResult> {
  return updateWorkspaceRules(file, ownerKey, baseFingerprint, () => ({ text: "" }), { allowOpaque: true });
}
