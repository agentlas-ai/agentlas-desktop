/*
 * The computer's half of "files that come with the mirror" (Agentlas 2.0 VD; contracts/one-home-mirror.md section 3A, section 5 "send it on to the Mac").
 * A server bubble the home computer takes (home-mirror.ts, section `messages`) may carry `files:[{id,name,mime,bytes?} | {url,name,mime,bytes?}]`. This file turns those lines into files on this computer:
 *   - `{id}`  the server's own saved file: `POST mirror/file` (signed by this computer's key, the pointer's epoch) answers a 15 minute link of the object store; the bytes come from that link;
 *   - `{url}` an OUTSIDE address (the phone's own download of a service's result; the server holds no byte): taken with no key and no signature, after the check every outside address gets
 *             (net/public-address-guard.ts: https only, no private / loopback / link-local / reserved address after the name is resolved and after every redirect, the connection pinned to the checked address).
 * Both end the same way: streamed to disk (never held in memory), counted and hashed as they arrive, a half file is never a received file, then placed where this chat's results already live
 * (`one_artifact_bindings` through the same binder a run's own file uses - the "Earlier outputs" of the personal agent's conversation) and nowhere else. No new table, no new screen, no timer, no model.
 *
 * What is kept on disk, under `<userData>/generated-assets/mirror-files/<account>/` (this file's own folder; the port gives the root):
 *   jobs/<key>.json        one file still to take (written BEFORE the messages are acknowledged, so a crash never loses a file the server will not offer again); removed when the file is placed or ends for good
 *   parts/<key>.part       the bytes so far (a retry asks for the rest with Range, or starts again when the server will not); removed with its job
 *   files/<key>/<name>     the received file (+ `.receipt.json`: the server turn it came with, size, sha-256, time). `<key>` = first 16 hex of sha-256 of "kind\nid-or-url", so the SAME file offered twice is one file.
 * Who reads it: this file. Who deletes it: the job when done/ended, `forgetTurn` (the server forgot that turn), `forgetAccount` (jobs and parts only), and the sweep of received files older than the binding's
 * own life (90 days, db.ts one_artifact_bindings purge) - so the disk holds a received file exactly as long as the results list can show it.
 *
 * Closed words (never a sentence of the server or of the other service): `expired` (server ticket past 7 days: one quiet line in the conversation), `gone` (the file is deleted / the outside address ended:
 * nothing is shown), `unsupported` (a kind this computer does not open from outside: no download), `too_large`, `refused_address`, `not_shown`. Everything else is `retry`: the job stays and the next signal
 * tries again (a backoff in memory only). Nothing here reads a word of a file to decide what it is: the name's extension and the closed tables decide. No Electron import (a gate drives it with fakes).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { requestTimeoutMs } from "./bundle-stream";

const MIB = 1024 * 1024;

// ───────────────────────── numbers (each with its reason) ─────────────────────────
export const MIRROR_FILE_LIMITS = Object.freeze({
  /** A file of the server is at most 200 MiB (section 5; V3 `media-jobs.ts:17`). A larger one is never taken. */
  maxBytes: 200 * 1024 * 1024,
  /** Contract section 3A: at most 4 lines per bubble. A longer list is cut (the rest is not offered by the server anyway). */
  perBubble: 4,
  /** The server's ticket lives 7 days (contract section 3A `file_expired`): a job that old can never be taken, so it ends. */
  jobLifeMs: 7 * 24 * 3_600_000,
  /** Received files are kept as long as the results list keeps their binding: db.ts purges `one_artifact_bindings` rows older than 90 days. */
  keepMs: 90 * 24 * 3_600_000,
  /**
   * The sweep of old received files and of parts with no job. It is NOT a timer: it is a throttle read inside `drain`, so it runs only when a mirror signal (start, a take) asks for a pass, at most once per this gap (and once
   * after each start). basis: the keep rule it serves is 90 days (keepMs), so a daily look leaves a file at most one day past its life; one sweep reads one folder listing and one small receipt per received file
   * (measured in the gate: 2,000 received files). Reached: files older than keepMs and their results-list entries go; parts with no job go.
   */
  sweepGapMs: 24 * 3_600_000,
  /** The id is V3's signed ticket, <= 2,048 characters (contract section 3A). */
  idChars: 2_048,
  /** An outside address: the longest the phone/server stores in a bubble line (V3 `cleanFiles` keeps 2,048); a little more room for a signed query. */
  urlChars: 4_096,
  /**
   * The wait for an answer's headers. basis: the base wait the app gives any request to its own server and the object store (one/bundle-stream.ts requestTimeoutMs(0) = 60 s: "the time a request may take",
   * the rule the locked-bundle moves already use). Reached: the attempt ends (the part on disk stays), the job stays and is tried again after the retry gap below; nothing is shown to the person.
   */
  headerTimeoutMs: requestTimeoutMs(0),
  /**
   * A body that sends nothing for this long is cut and tried again. basis: the same base (requestTimeoutMs(0) = 60 s) - the longest the app lets the other side stay silent before it says anything,
   * so a body is never judged more strictly than its own header. Reached: the connection is closed, the part stays and the next attempt asks for the rest with Range (a stalled download holds no memory and no disk beyond its part).
   */
  idleMs: requestTimeoutMs(0),
  /**
   * The gap before the next try of one job after a failed one, doubling up to retryGapMaxMs. basis: the mirror's own backoff (home-mirror.ts BACKOFF_FIRST_MS 15 s, BACKOFF_MAX_MS 30 min; a gate asserts the numbers are equal) and the
   * server's own limit on this route: `mirror/file` is charged to the "export" bucket, 400 requests per 10 minutes per account (web one-home/http.ts ONE_HOME_LIMITS.export). With 15 s doubling one waiting job asks at most 6 times in
   * its first 10 minutes and about 54 times in the first day (measured), so 60+ jobs stuck at once are needed to touch the limit (measured with a fake clock in the gate). Reached: the cap holds the gap at 30 minutes; the job's 7 days end it.
   */
  retryGapMs: 15_000,
  retryGapMaxMs: 30 * 60_000,
  /** Redirects of an outside address, each hop re-checked (the guard's own default). */
  maxRedirects: 3,
  /** Windows paths are 260 characters: userData + generated-assets\mirror-files\<12>\files\<16>\ is about 150, so a name stays within 80. */
  nameChars: 80,
});

/**
 * Kinds this computer takes from outside and shows (the binder's table minus everything a browser or a shell could run: no html/svg/xml/js/shell, no macro-enabled Office, no executable, no disk image), grouped by the
 * binder's kind so each group carries the binder's own size limit (one/artifact-preview.ts MAX_*_BYTES; a gate asserts every extension here has the same limit there).
 */
const EXT_BY_KIND: Readonly<Record<"image" | "video" | "audio" | "document" | "data", readonly string[]>> = {
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp"],
  video: [".mp4", ".webm", ".mov", ".m4v", ".ogv"],
  audio: [".mp3", ".m4a", ".wav", ".ogg", ".flac", ".aac"],
  document: [".pdf", ".doc", ".docx", ".rtf", ".odt", ".pages", ".hwp", ".hwpx", ".ppt", ".pptx", ".odp", ".key", ".txt", ".md"],
  data: [".xls", ".xlsx", ".csv", ".tsv", ".ods", ".numbers", ".zip"],
};
/**
 * The most the results list's binder binds of one file, by kind. basis: the binder's own numbers (one/artifact-preview.ts MAX_IMAGE_BYTES 24 MiB, MAX_VIDEO_BYTES 192, MAX_AUDIO_BYTES 96, MAX_DOCUMENT_BYTES 64,
 * MAX_DATA_BYTES 64 - spreadsheets and zip), because a larger received file is refused by the binder and deleted: the bytes were taken for nothing. Reached: a file whose declared size is over its limit is not
 * taken at all (no body request) and one quiet line says so; a file with no declared size is counted while it arrives and cut at the limit.
 */
const BINDER_CAP_BYTES: Readonly<Record<keyof typeof EXT_BY_KIND, number>> = Object.freeze({ image: 24 * MIB, video: 192 * MIB, audio: 96 * MIB, document: 64 * MIB, data: 64 * MIB });
const CAP_OF_EXT: ReadonlyMap<string, number> = new Map((Object.keys(EXT_BY_KIND) as Array<keyof typeof EXT_BY_KIND>).flatMap((kind) => EXT_BY_KIND[kind].map((ext) => [ext, BINDER_CAP_BYTES[kind]] as const)));
const RECEIVABLE_EXT: ReadonlySet<string> = new Set(CAP_OF_EXT.keys());
/** The most of this file the computer will take: the binder's limit for its kind (never above the server's 200 MiB), or null for a name this computer does not take. */
export function binderCapOf(name: string): number | null {
  const cap = CAP_OF_EXT.get(path.extname(name).toLowerCase());
  return cap === undefined ? null : Math.min(MIRROR_FILE_LIMITS.maxBytes, cap);
}
/** A name with no usable extension gets one from the media type the line names (closed table; anything else stays without). */
const EXT_OF_MIME: Readonly<Record<string, string>> = Object.freeze({
  "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/ogg": ".ogg", "audio/flac": ".flac", "audio/aac": ".aac",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
  "application/pdf": ".pdf", "text/plain": ".txt", "text/markdown": ".md", "text/csv": ".csv", "application/zip": ".zip",
});
/** Windows device names (also with an extension: `CON.txt`) cannot be file names there; the same rule on every OS so a synced path means the same thing. */
const RESERVED_BASE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

// ───────────────────────── pure helpers (also the gate's vectors) ─────────────────────────
const sha256hex = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export const fileKey = (kind: "id" | "url", ref: string): string => sha256hex(`${kind}\n${ref}`).slice(0, 16);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A name from outside as a safe name for a file of this computer: the last path piece only (`../x` and `a\b` lose their folders), no control or bidi-control character, none of the characters Windows
 * forbids (`<>:"|?*`), no leading/trailing dot or space, a Windows device name gets `_` in front, at most 80 characters (an extension is kept), empty -> `file`. The same on every OS.
 */
export function safeFileName(raw: string, mime = ""): string {
  let name = String(raw ?? "").normalize("NFC");
  name = name.split(/[\\/]/).pop() ?? "";
  name = name.replace(/[\u0000-\u001f\u007f\u0080-\u009f​-‏‪-‮⁠-⁩﻿<>:"|?*]/g, "").replace(/\s+/g, " ");
  name = name.replace(/^[. ]+/, "").replace(/[. ]+$/, "");
  let ext = path.extname(name);
  let base = ext ? name.slice(0, name.length - ext.length) : name;
  if (!RECEIVABLE_EXT.has(ext.toLowerCase())) {
    const fromMime = EXT_OF_MIME[String(mime).split(";")[0].trim().toLowerCase()];
    if (fromMime) { base = name; ext = fromMime; }
  }
  base = base.replace(/[. ]+$/, "");
  if (base === "" ) base = "file";
  if (RESERVED_BASE.test(base)) base = `_${base}`;
  const room = Math.max(1, MIRROR_FILE_LIMITS.nameChars - ext.length);
  const cut = Array.from(base).slice(0, room).join("");
  return `${cut}${ext.toLowerCase()}`;
}
export function isReceivableName(name: string): boolean { return RECEIVABLE_EXT.has(path.extname(name).toLowerCase()); }

export interface FileLine { kind: "id" | "url"; /** where an address came from (`src` of the server's line): only "service" is taken by this computer */ src: "service" | "open" | null; ref: string; name: string; mime: string; bytes: number | null; sha256: string | null }
export type LineRefusal = "bad_line" | "unsupported" | "too_large" | "not_shown" | "refused_address" | "link_only";
const URL_BAD = /[\u0000- \u007f]/;

/** One `files[]` line of a pulled bubble -> a line to take, or a closed word. Only the keys of the contract are read; `sha256` is read if a later server sends it. */
export function fileLineOf(raw: unknown): { ok: true; line: FileLine } | { ok: false; why: LineRefusal; /** set for "too_large" and "not_shown": the line that would have been taken (its key names the quiet line) */ line?: FileLine } {
  if (!isRecord(raw)) return { ok: false, why: "bad_line" };
  const hasId = typeof raw.id === "string", hasUrl = typeof raw.url === "string";
  if (hasId === hasUrl) return { ok: false, why: "bad_line" };                 // exactly one of id / url
  const mime = typeof raw.mime === "string" ? raw.mime.slice(0, 128) : "";
  const bytes = Number.isSafeInteger(raw.bytes) && (raw.bytes as number) >= 0 ? (raw.bytes as number) : null;
  const sha = typeof raw.sha256 === "string" && /^[a-f0-9]{64}$/i.test(raw.sha256) ? raw.sha256.toLowerCase() : null;
  const name = safeFileName(typeof raw.name === "string" ? raw.name : "", mime);
  if (!isReceivableName(name)) return { ok: false, why: "unsupported" };
  // The server's own limit (200 MiB) and the results list's limit for this kind: a file the list cannot show is not taken, and the person is told once (the `not_shown` line) instead of the file vanishing.
  const overServer = bytes !== null && bytes > MIRROR_FILE_LIMITS.maxBytes;
  const overCap = bytes !== null && bytes > (binderCapOf(name) ?? MIRROR_FILE_LIMITS.maxBytes);
  const refusal = overServer ? "too_large" : "not_shown";
  if (hasId) {
    const id = raw.id as string;
    if (id.length === 0 || id.length > MIRROR_FILE_LIMITS.idChars || /[\u0000-\u001f\u007f]/.test(id)) return { ok: false, why: "bad_line" };
    const line: FileLine = { kind: "id", src: null, ref: id, name, mime, bytes, sha256: sha };
    return overCap ? { ok: false, why: refusal, line } : { ok: true, line };
  }
  const url = raw.url as string;
  if (url.length === 0 || url.length > MIRROR_FILE_LIMITS.urlChars || URL_BAD.test(url)) return { ok: false, why: "bad_line" };
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, why: "bad_line" }; }
  // the cheap half of the outside-address rule, here so a line that can never pass is never written down; the full check (names resolved, redirects) runs at the connection
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port !== "" && parsed.port !== "443")) return { ok: false, why: "refused_address" };
  // The server marks where an address came from (`src`): a result address of a catalog service called with the person's key ("service") is taken; an address from a keyless request ("open") or with no mark is NOT taken -
  // this computer makes no request for it at all (0 requests, no job); it stays a link the person may open.
  if (raw.src !== "service") return { ok: false, why: "link_only" };
  const line: FileLine = { kind: "url", src: "service", ref: url, name, mime, bytes, sha256: sha };
  return overCap ? { ok: false, why: refusal, line } : { ok: true, line };
}

// ───────────────────────── ports ─────────────────────────
export interface OpenedBody { status: number; headers: Record<string, string | string[] | undefined>; body: AsyncIterable<Buffer | string> & { destroy(error?: Error): void } }
export interface SignedAnswer { ok: boolean; status?: number; code?: string; unreachable?: boolean; body?: Record<string, unknown> | null }
export type PlaceResult = "shown" | "refused" | "retry";
export interface MirrorFilesPorts {
  now(): number;
  /** The folder of this account's received files (created by this file, mode 0700), or null when there is none (no user data folder). */
  root(userId: string): string | null;
  /** `POST mirror/file {epoch, id}` signed by this computer. Never throws. */
  signedLink(id: string): Promise<SignedAnswer>;
  /** One GET of an outside address (https, checked, pinned, redirects followed with every hop re-checked); the body is NOT read. Throws a closed refusal `{ code }` for an address that is not public. */
  open(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<OpenedBody>;
  /** Put a received file where the conversation's results live; `refused` = the results list cannot show it (a kind or size it does not bind), `retry` = not now (no conversation or task yet). */
  place(file: { filePath: string; name: string; key: string }): PlaceResult;
  /** The results-list entries of these files go (the files are being deleted). */
  unplace(filePaths: string[]): void;
  /** "That file is expired / too large to show" as one quiet line in the conversation, once (the id of the line is stable per file, so a second try inserts nothing). */
  note(line: { key: string; code: "expired" | "not_shown"; name: string; turn: string; bubbleAt: string }): void;
  /** Is this computer still allowed to take (the 2.0 switch is on and it is the confirmed home)? Asked between files and about once per MiB of a body: switched off = the next request is not made. */
  mayTake(): boolean;
}
export interface MirrorFilesStatus { pending: number; done: number }
export interface DrainReport { ran: boolean; done: number; waiting: number; expired: number; gone: number; refused: number; unsupported: number; requests: number }
const emptyReport = (): DrainReport => ({ ran: false, done: 0, waiting: 0, expired: 0, gone: 0, refused: 0, unsupported: 0, requests: 0 });

interface Job {
  v: 1; key: string; kind: "id" | "url"; ref: string; name: string; mime: string; bytes: number | null; sha256: string | null;
  /** the server's turn key of the bubble (what a forget stamp names), its message id and time */
  turn: string; msg: string; at: string; savedAt: number;
}
interface Receipt { v: 1; key: string; turn: string; msg: string; name: string; bytes: number; sha256: string; at: number }

const writeJson = (file: string, value: unknown): void => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
};
const readJson = <T>(file: string): T | null => { try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; } };
const rmQuiet = (target: string): void => { try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* gone or locked: the next sweep */ } };
const headerOf = (h: OpenedBody["headers"], name: string): string | undefined => { const v = h[name]; return Array.isArray(v) ? v[0] : v; };

export function createMirrorFiles(ports: MirrorFilesPorts, limits: Pick<typeof MIRROR_FILE_LIMITS, "idleMs" | "retryGapMs" | "retryGapMaxMs" | "sweepGapMs"> = MIRROR_FILE_LIMITS) {
  let draining: Promise<DrainReport> | null = null;
  let lastSweepAt = 0;
  const nextTry = new Map<string, { at: number; n: number }>();        // memory only: when a job may be tried again
  const dirs = (userId: string): { root: string; jobs: string; parts: string; files: string } | null => {
    const root = ports.root(userId); if (!root) return null;
    return { root, jobs: path.join(root, "jobs"), parts: path.join(root, "parts"), files: path.join(root, "files") };
  };
  /** The most of this job's file the computer takes (the binder's limit for its kind, never above the server's 200 MiB). */
  const capOf = (name: string): number => binderCapOf(name) ?? MIRROR_FILE_LIMITS.maxBytes;
  /** One quiet line: the file was too big for the results list and was not taken. */
  const notShown = (job: Job): void => { try { ports.note({ key: job.key, code: "not_shown", name: job.name, turn: job.turn, bubbleAt: job.at }); } catch { /* the line is a courtesy */ } };
  const ensure = (d: { root: string; jobs: string; parts: string; files: string }): void => { for (const dir of [d.root, d.jobs, d.parts, d.files]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); };

  /**
   * Write down the files of the bubbles just taken, BEFORE the caller acknowledges those messages (the server will not offer them again after the acknowledgement). `ok: false` = a job could not be
   * written (disk full, no folder): the caller must NOT acknowledge, so the same bubbles come again at the next signal. A line that can never be taken is counted, not written.
   */
  function plan(userId: string, items: unknown[]): { ok: boolean; planned: number; known: number; refused: Record<string, number> } {
    const out = { ok: true, planned: 0, known: 0, refused: {} as Record<string, number> };
    const d = dirs(userId);
    for (const raw of items) {
      if (!isRecord(raw) || !Array.isArray(raw.files) || raw.files.length === 0) continue;
      const turn = typeof raw.turnId === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(raw.turnId) ? raw.turnId : "";
      const msg = typeof raw.id === "string" && raw.id.length <= 128 ? raw.id : "";
      const at = typeof raw.createdAt === "string" ? raw.createdAt : new Date(ports.now()).toISOString();
      for (const entry of raw.files.slice(0, MIRROR_FILE_LIMITS.perBubble)) {
        const made = fileLineOf(entry);
        if (!made.ok) {
          out.refused[made.why] = (out.refused[made.why] ?? 0) + 1;
          // A file too big for the results list is not taken (no request at all), and the person is told once instead of the file vanishing (the line's id is the file's own key, so a second offer adds nothing).
          if ((made.why === "not_shown" || made.why === "too_large") && made.line) {
            try { ports.note({ key: fileKey(made.line.kind, made.line.ref), code: "not_shown", name: made.line.name, turn, bubbleAt: at }); } catch { /* the line is a courtesy */ }
          }
          continue;
        }
        if (!d) { out.ok = false; continue; }
        const line = made.line, key = fileKey(line.kind, line.ref);
        try {
          ensure(d);
          if (fs.existsSync(path.join(d.files, key, ".receipt.json")) || fs.existsSync(path.join(d.jobs, `${key}.json`))) { out.known += 1; continue; }   // the same file offered twice is one file
          const job: Job = { v: 1, key, kind: line.kind, ref: line.ref, name: line.name, mime: line.mime, bytes: line.bytes, sha256: line.sha256, turn, msg, at, savedAt: ports.now() };
          writeJson(path.join(d.jobs, `${key}.json`), job);
          out.planned += 1;
        } catch { out.ok = false; }
      }
    }
    return out;
  }

  /** What the server forgot (a `gone` stamp that names a turn): the received files of that turn and its waiting jobs go, and so do their entries in the results list. */
  function forgetTurn(userId: string, turn: string): number {
    const d = dirs(userId); if (!d || !turn) return 0;
    let removed = 0; const placed: string[] = [];
    try {
      for (const name of fs.readdirSync(d.files)) {
        const receipt = readJson<Receipt>(path.join(d.files, name, ".receipt.json"));
        if (receipt?.turn === turn) { placed.push(path.join(d.files, name, receipt.name)); rmQuiet(path.join(d.files, name)); removed += 1; }
      }
    } catch { /* no folder yet */ }
    try {
      for (const name of fs.readdirSync(d.jobs)) {
        if (!name.endsWith(".json")) continue;
        const job = readJson<Job>(path.join(d.jobs, name));
        if (job?.turn === turn) { rmQuiet(path.join(d.jobs, name)); rmQuiet(path.join(d.parts, `${job.key}.part`)); removed += 1; }
      }
    } catch { /* none */ }
    if (placed.length) { try { ports.unplace(placed); } catch { /* the entry is a row of a 90-day index; a dead entry shows "file missing" */ } }
    return removed;
  }

  /** Account slot forgotten / another account signs in: what is still waiting is dropped (nothing was received yet). Received files stay: they are the person's. */
  function forgetAccount(userId: string): void {
    const d = dirs(userId); if (!d) return;
    rmQuiet(d.jobs); rmQuiet(d.parts);
    nextTry.clear();
  }

  function sweepOld(d: { files: string }): void {
    let names: string[] = []; try { names = fs.readdirSync(d.files); } catch { return; }
    const now = ports.now();
    for (const name of names) {
      const receipt = readJson<Receipt>(path.join(d.files, name, ".receipt.json"));
      if (!receipt) { try { if (now - fs.statSync(path.join(d.files, name)).mtimeMs > MIRROR_FILE_LIMITS.keepMs) rmQuiet(path.join(d.files, name)); } catch { /* gone */ } continue; }
      if (now - receipt.at > MIRROR_FILE_LIMITS.keepMs) { try { ports.unplace([path.join(d.files, name, receipt.name)]); } catch { /* ignore */ } rmQuiet(path.join(d.files, name)); }
    }
  }

  async function takeOne(d: { jobs: string; parts: string; files: string }, job: Job, report: DrainReport): Promise<"done" | "ended" | "retry"> {
    const jobFile = path.join(d.jobs, `${job.key}.json`);
    const partFile = path.join(d.parts, `${job.key}.part`);
    const finalDir = path.join(d.files, job.key);
    const finalFile = path.join(finalDir, job.name);
    const end = (): "ended" => { rmQuiet(jobFile); rmQuiet(partFile); return "ended"; };
    if (ports.now() - job.savedAt > MIRROR_FILE_LIMITS.jobLifeMs) return end();
    // the file is already on disk (a crash between the rename and the placing): only the placing is left
    if (fs.existsSync(path.join(finalDir, ".receipt.json")) && fs.existsSync(finalFile)) return settle(job, finalFile, jobFile, partFile, report);
    let source = job.ref; let expected = job.bytes;
    if (job.kind === "id") {
      report.requests += 1;
      const answer = await ports.signedLink(job.ref);
      if (!answer.ok) {
        const code = answer.code ?? "";
        if (code === "file_expired") { try { ports.note({ key: job.key, code: "expired", name: job.name, turn: job.turn, bubbleAt: job.at }); } catch { /* the line is a courtesy */ } report.expired += 1; return end(); }
        if (code === "file_gone" || code === "file_not_found") { report.gone += 1; return end(); }   // nothing is shown: the person had it forgotten, or it was never this account's
        return "retry";                                                 // unavailable, a network cut, a closed switch, a clock refusal: the next signal
      }
      const url = answer.body?.url; const bytes = answer.body?.bytes;
      if (typeof url !== "string") return "retry";
      source = url; expected = Number.isSafeInteger(bytes) ? (bytes as number) : expected;
      if (expected !== null && expected > capOf(job.name)) { notShown(job); report.refused += 1; return end(); }   // the server's own size says it: no body request
    }
    // ── the bytes: resume the part, or start again ──
    let have = 0; try { have = fs.statSync(partFile).size; } catch { have = 0; }
    if (expected !== null && have > expected) { rmQuiet(partFile); have = 0; }
    const controller = new AbortController();
    let idle: ReturnType<typeof setTimeout> | null = null;
    const touch = (): void => { if (idle) clearTimeout(idle); idle = setTimeout(() => controller.abort(), limits.idleMs); };
    let fd: number | null = null;
    try {
      report.requests += 1;
      touch();
      let response: OpenedBody;
      try { response = await ports.open(source, have > 0 ? { Range: `bytes=${have}-` } : {}, controller.signal); }
      catch (error) {
        const code = (error as { code?: string })?.code;
        if (job.kind === "url" && (code === "blocked_private_address" || code === "blocked_insecure_url" || code === "too_many_redirects")) { report.refused += 1; return end(); }
        return "retry";
      }
      const status = response.status;
      if (status === 404 || status === 410) { response.body.destroy(); if (job.kind === "url") { report.gone += 1; return end(); } return "retry"; }
      if (status === 416) { response.body.destroy(); rmQuiet(partFile); return "retry"; }
      if (status !== 200 && status !== 206) { response.body.destroy(); if (job.kind === "url" && status >= 400 && status < 500 && status !== 408 && status !== 429) { report.gone += 1; return end(); } return "retry"; }
      let start = 0; let total: number | null = null;
      if (status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(headerOf(response.headers, "content-range") ?? "");
        if (!range || Number(range[1]) !== have) { response.body.destroy(); rmQuiet(partFile); return "retry"; }
        start = have; total = range[3] === "*" ? null : Number(range[3]);
      } else {
        const length = Number(headerOf(response.headers, "content-length"));
        total = Number.isSafeInteger(length) && length >= 0 ? length : null;
        if (have > 0) { rmQuiet(partFile); have = 0; }                  // the server sent the whole file again
      }
      if (total !== null && total > capOf(job.name)) { response.body.destroy(); notShown(job); report.refused += 1; return end(); }   // the headers say it: the body is never read
      const hash = createHash("sha256");
      if (start > 0) {                                               // the hash of the part already on disk
        const rfd = fs.openSync(partFile, "r"); const buf = Buffer.allocUnsafe(1 << 20);
        try { for (let at = 0; at < start;) { const n = fs.readSync(rfd, buf, 0, Math.min(buf.length, start - at), at); if (n <= 0) break; hash.update(buf.subarray(0, n)); at += n; } } finally { fs.closeSync(rfd); }
      }
      fd = fs.openSync(partFile, start > 0 ? "a" : "w", 0o600);
      let received = start; let sinceCheck = 0;
      const cap = capOf(job.name);
      const limit = Math.min(cap, expected !== null && job.kind === "id" ? expected : cap);
      try {
        for await (const chunk of response.body) {
          touch();
          const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          received += buf.byteLength; sinceCheck += buf.byteLength;
          if (received > limit) {
            response.body.destroy(); fs.closeSync(fd); fd = null; rmQuiet(partFile);
            // Counted bytes are the truth: past the results list's limit the file is not taken, whatever the server said (or did not say) about its size.
            if (received > cap) { notShown(job); report.refused += 1; return end(); }
            if (job.kind === "url") { report.refused += 1; return end(); }
            return "retry";
          }
          hash.update(buf);
          fs.writeSync(fd, buf);
          if (sinceCheck >= 1 << 20) { sinceCheck = 0; if (!ports.mayTake()) { response.body.destroy(); fs.closeSync(fd); fd = null; return "retry"; } }
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } fd = null; }
        if (code === "ENOSPC" || code === "EDQUOT") rmQuiet(partFile);   // a full disk: the part goes too (it is what filled it); the job waits
        return "retry";
      }
      fs.closeSync(fd); fd = null;
      if (total !== null && received !== total) return "retry";         // the connection ended early: the part stays, the next try asks for the rest
      if (job.kind === "id" && expected !== null && received !== expected) { rmQuiet(partFile); return "retry"; }   // contract section 9: a size that differs is thrown away and taken again
      const digest = hash.digest("hex");
      if (job.sha256 && job.sha256 !== digest) { rmQuiet(partFile); return "retry"; }
      // ── commit: the rename is the moment the file is "received" ──
      fs.mkdirSync(finalDir, { recursive: true, mode: 0o700 });
      if (path.resolve(finalFile).indexOf(path.resolve(finalDir) + path.sep) !== 0) { rmQuiet(partFile); return end(); }   // a name that left its folder: never
      try { fs.renameSync(partFile, finalFile); }
      catch { await new Promise((r) => setTimeout(r, 50)); try { fs.renameSync(partFile, finalFile); } catch { return "retry"; } }   // a scanner may hold a new file on Windows for a moment
      writeJson(path.join(finalDir, ".receipt.json"), { v: 1, key: job.key, turn: job.turn, msg: job.msg, name: job.name, bytes: received, sha256: digest, at: ports.now() } satisfies Receipt);
      return settle(job, finalFile, jobFile, partFile, report);
    } finally {
      if (idle) clearTimeout(idle);
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
    }
  }

  function settle(job: Job, finalFile: string, jobFile: string, partFile: string, report: DrainReport): "done" | "ended" | "retry" {
    let placed: PlaceResult = "retry";
    try { placed = ports.place({ filePath: finalFile, name: job.name, key: job.key }); } catch { placed = "retry"; }
    if (placed === "retry") return "retry";                              // the file is kept: only the placing is retried
    if (placed === "refused") { rmQuiet(path.dirname(finalFile)); rmQuiet(jobFile); rmQuiet(partFile); report.refused += 1; return "ended"; }   // a file the results list cannot show is not kept
    rmQuiet(jobFile); rmQuiet(partFile); report.done += 1;
    return "done";
  }

  /** One pass over the waiting jobs, oldest first, one try each. Single flight: a signal during a pass joins it. Requests are made only while `mayTake()` says the computer may take. */
  function drain(userId: string): Promise<DrainReport> {
    if (draining) return draining;
    const flight = (async (): Promise<DrainReport> => {
      const report = emptyReport();
      const d = dirs(userId);
      if (!d || !ports.mayTake()) return report;
      if (!fs.existsSync(d.jobs) && !fs.existsSync(d.files)) return report;      // this account never took a file: no folder is made by a look
      report.ran = true;
      if (ports.now() - lastSweepAt >= limits.sweepGapMs) {
        lastSweepAt = ports.now();
        sweepOld(d);
        // a part with no job belongs to nothing: it goes
        try { for (const name of fs.readdirSync(d.parts)) if (!fs.existsSync(path.join(d.jobs, name.replace(/\.part$/, ".json")))) rmQuiet(path.join(d.parts, name)); } catch { /* none */ }
      }
      let names: string[] = []; try { names = fs.readdirSync(d.jobs).filter((n) => n.endsWith(".json")); } catch { names = []; }
      const jobs = names.map((n) => readJson<Job>(path.join(d.jobs, n))).filter((j): j is Job => !!j && j.v === 1 && /^[a-f0-9]{16}$/.test(j.key) && (j.kind === "id" || j.kind === "url")).sort((a, b) => a.savedAt - b.savedAt);
      for (const job of jobs) {
        if (!ports.mayTake()) break;
        const wait = nextTry.get(job.key);
        if (wait && ports.now() < wait.at) { report.waiting += 1; continue; }
        let outcome: "done" | "ended" | "retry";
        try { outcome = await takeOne(d, job, report); } catch { outcome = "retry"; }
        if (outcome === "retry") {
          const n = (wait?.n ?? 0) + 1;
          nextTry.set(job.key, { n, at: ports.now() + Math.min(limits.retryGapMaxMs, limits.retryGapMs * 2 ** (n - 1)) });
          report.waiting += 1;
        } else nextTry.delete(job.key);
      }
      return report;
    })().finally(() => { draining = null; });
    draining = flight;
    return flight;
  }

  function status(userId: string): MirrorFilesStatus {
    const d = dirs(userId); if (!d) return { pending: 0, done: 0 };
    const count = (dir: string): number => { try { return fs.readdirSync(dir).length; } catch { return 0; } };
    return { pending: count(d.jobs), done: count(d.files) };
  }

  return { plan, drain, forgetTurn, forgetAccount, status, _peek: () => ({ draining: draining !== null, backoff: nextTry.size }) };
}
export type MirrorFiles = ReturnType<typeof createMirrorFiles>;
