// The personal agent's move bundle: pack, stage, check, import, purge (Agentlas 2.0 O-M2,-memory-algorithm 5.8.5-5.8.8; engine pair `agentlas_cloud.one_pack`).
//
// NOT CALLED BY ANYTHING YET. No screen, no IPC, no start-up step and no timer reaches this file; O-M3 (the home record and the first move) is the caller. Every function here
// is a plain function with its ports passed in, so the caller decides when, and a test can run it against synthetic homes.
//
// What a bundle holds (all of it text; a folder of at most these files, nothing else is accepted):
//   memory.sqlite      the engine's pack: live Personal memory lines + the Personal forget stamps (hashes only)         written by the engine, `one_pack export`
//   conversation.jsonl the personal conversation's TEXT: {id, role, text, createdAt, kind?, hostNotice?}               no photos, no files, no attachments
//   context-seed.json  the last 20 turns' text, planted once in the receiver's context journal                          by the caller's port, once per pack id
//   profile.json, avatar.bin (<= 2 MiB), checkins.jsonl, settings.json, reconnect.json (NAMES only)                    carried and handed back; the profile table is O-M3's
//   manifest.json      schema, pack id, sizes and sha-256 of every file, counts, what was left out
// Never in it: other agents' and projects' memory, session memory, the machine's work knowledge, photos and files, checkpoints, delegated team sessions and rooms, built files,
// automations, anything bound to the keychain, the "my rules" file, forgotten or replaced lines. A bundle over 8 MiB is never refused: the embeddings go first (the
// receiver builds them again), then the oldest conversation lines; the answer says how many.
//
// Where the files live, and who deletes them (resource rule: no temp folder without its deleter):
//   sender   `packOne` makes `<workDir>/one-pack-<id>/` (marker OWNER.json, the bundle files, `purge-ids.json` that is never sent). It is removed by `purgePacked` when the purge is
//            finished, or by `discardPacked` (cancel, failure). `reclaimStaleDirs(workDir)` removes the ones whose owner process is gone (a crash), proved by the marker.
//   receiver `stageBundle` copies a verified bundle into `<stagingBase>/one-staged-<id>/` (same marker). It is removed by `importStaged` when the import is finished or the bundle
//            is unusable, by `discardStaged`, and by `reclaimStaleDirs` after a crash. A call that must be repeated (store busy, no personal conversation yet) keeps it.
// Failure codes are machine codes; no sentence is made here.
//
// A bundle is untrusted input (nothing in this file checks who sent it; that is O-M3's). What the receiver does with a conversation: a line with role `system` is dropped (counted, never stored), a line's
// `hostNotice` is never stored (a notice is how the host marks its OWN housekeeping and continuation lines; the model's replay reads it as host-authored, so a bundle cannot be allowed to forge one), and the lines go
// into the personal conversation of THIS computer only: the one bound now, or the one the caller makes (`ensurePersonalChat`). A chat is never bound from what the bundle's ids happen to match: the only mark in this
// code that says "this was the personal conversation before the move" would be the read-only "before the move" record of O-M3, which does not exist yet, so there is no rebinding at all.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { parseChatHostNotice } from "../../shared/chat-host-notice";
import { leftToRetry, noteLeftThatEndsHere, readLeftReasons, type LeftReasons } from "../memory/engine-left";

export const BUNDLE_SCHEMA = "agentlas.one-bundle.v1";
/**
 * THE size limit of a bundle: one constant. Everything else derives from it - the wire limit (transport.ts `BUNDLE_WIRE_MAX`), the headroom of the checks (`BUNDLE_SLACK_BYTES`), the memory room (`memoryRoomBytes`), the disk the move needs (home-move.ts).
 * 100 MiB. What is USED for one move is decided per move (home-move.ts): 100 MiB only when the engine lists `limit_100mib` and the server has not refused a big bundle (`bundle_too_large` on the put); otherwise `BUNDLE_LEGACY_LIMIT_BYTES`.
 */
export const BUNDLE_LIMIT_BYTES = 100 * 1024 * 1024;
/** What an engine without `limit_100mib` and a server that takes only 9 MiB (before reached production) can carry: the road of every combination that cannot do 100 MiB. */
export const BUNDLE_LEGACY_LIMIT_BYTES = 8 * 1024 * 1024;
export const BUNDLE_MAX_BYTES = BUNDLE_LIMIT_BYTES;
/** Headroom the checks allow over the limit for the files around the memory file (the same 64 KiB as the engine's `check`). */
export const BUNDLE_SLACK_BYTES = 64 * 1024;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const CONTEXT_SEED_TURNS = 20;
const SEED_TEXT_MAX = 8_000;
const LINE_TEXT_MAX = 1_000_000;
const SMALL_FILE_MAX = 256 * 1024;
const NAME_LIST_MAX = 200;
/** Audit 59 F-12: a conversation of a bundle is at most this many lines (the newest are kept, the count of the rest is told). A bundle is at most 8 MiB and the shortest line is about 75 bytes, so a real sender
 * (`packOne` trims to 8 MiB) never reaches this; a hostile one cannot make this computer insert an unbounded number of rows in one transaction. */
export const CONVERSATION_LINES_MAX = 100_000;
/** Audit 59 F-12: a line's `createdAt` orders it among the owner's lines; the engine takes the same: ISO 8601, not later than now plus ten minutes (clock difference between two computers). */
const FUTURE_SKEW_MS = 10 * 60_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
export function createdAtOk(value: unknown, now: number = Date.now()): boolean {
  if (typeof value !== "string" || value.length > 40 || !ISO_DATE.test(value)) return false;
  let text = value.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += "T00:00:00Z";
  else if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) text += "Z";
  text = text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = Date.parse(text);
  return Number.isFinite(t) && t <= now + FUTURE_SKEW_MS;
}
export const BUNDLE_FILES = ["memory.sqlite", "conversation.jsonl", "context-seed.json", "profile.json", "avatar.bin", "checkins.jsonl", "settings.json", "reconnect.json"] as const;
export type BundleFile = typeof BUNDLE_FILES[number];
const MARKER = "OWNER.json";
/** A pack folder that holds `purge-ids.json` is waiting for its purge (the list is the only record of which old lines to delete). `reclaimStaleDirs` leaves it alone while it is younger than this; only `purgePacked`
 * (when the purge is done) and `discardPacked` (the caller cancels) remove it sooner. The age is the marker's `createdAt`, written by `makeOwnedDir`. A move that has not purged in 30 days is abandoned. */
export const PACK_AWAITING_PURGE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const MARKER_KIND = "agentlas-one-bundle-owned-dir";
const PURGE_IDS = "purge-ids.json";
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

// --- ports ------------------------------------------------------------------------------------------------------------------

export interface ReconnectNames { providers: string[]; appKeys: string[]; mcpServers: string[] }
export interface BundleCheckin { id: string; [key: string]: unknown }

/** What the caller gives: the app database and the personal agent's id, and the sources and sinks that are not plain rows. Every optional port that is absent means "nothing to carry / not applied". */
export interface BundleHost {
  db: Database.Database;
  oneId: string;
  profile?(): Record<string, unknown> | null;
  avatar?(): Buffer | null;
  settings?(): Record<string, unknown> | null;
  reconnect?(): ReconnectNames | null;
  checkins?: { read(): BundleCheckin[]; /** union by id, returns how many were new (or, with the ones it refused to add, `{ added, dropped }`: audit 59 F-4) */ merge?(rows: BundleCheckin[]): number | { added: number; dropped: number } };
  /** The caller creates (or finds) the receiving personal conversation when none is bound; returns its chat id. Without it the conversation waits (`conversation_no_chat`). */
  ensurePersonalChat?(): string | null;
  /** Plants the seed once in the receiver's context journal; the event id must be derived from `packId` so a second call is a no-op. Returns whether it was planted now or already was. */
  plantContextSeed?(packId: string, turns: SeedTurn[]): boolean;
  /** Delegated work that is still running on this computer (shown before the move; it stays here). */
  activeWorkCount?(): number;
  /** How many older versions of Personal lines (replaced by an owner edit) this computer holds: a purge deletes the live lines by id and these stay ("what stays"). */
  olderVersionCount?(): number;
  /** Audit 61 N-2: makes the original-wording table of THIS computer's memory store exist (the desktop's own DDL, `ensureMemoryNativeTable`) BEFORE the engine imports. The engine puts the original wording of an imported line there only when the table
   * exists, and the sender's purge then deletes the sender's copy: without the table the words in the owner's language would exist nowhere. Throws when the table cannot be made: the import then does not run (`native_table_failed`, staging kept). Absent = nothing to do. */
  ensureNativeTable?(): void;
}
export interface SeedTurn { role: "user" | "assistant"; text: string; createdAt: string }

export interface EngineAnswer { state: string; reason?: string; [key: string]: unknown }
/**
 * Desktop repair 6 (engine `leftReasons`): an import or purge that answers `partial` because of what it LEFT. A left the engine says no retry changes (`views_path_too_long`: the derived view files cannot be written
 * on this machine) is not a reason to wait and call again: the lines themselves are in (or gone), only a derived file is not rewritten. It is told in the result (`leftReasons`) and in the memory screen's open
 * codes. A left that can pass, one the engine gave no reason for, and an engine without the column are what they were: the caller waits and calls again.
 */
function leftOfAnswer(answer: EngineAnswer | null | undefined): { left: string[]; reasons: LeftReasons | undefined; endsHere: boolean } {
  const left = answer && Array.isArray(answer.left) ? (answer.left as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 8) : [];
  const reasons = answer ? readLeftReasons(answer) : undefined;
  const endsHere = answer?.state === "partial" && left.length > 0 && leftToRetry(left, reasons).length === 0;
  if (answer?.state === "partial") noteLeftThatEndsHere(left, reasons);
  return { left, reasons, endsHere };
}
/** What an engine that takes the old-record road declares in every answer of `one_pack` (`features`). An older engine has no `features` and does not know the argument. */
const NO_STAMPS_FEATURES = ["no_stamps", "inserted_ids"] as const;
const hasFeatures = (answer: EngineAnswer | null | undefined, need: readonly string[]): boolean => !!answer && Array.isArray(answer.features) && need.every((f) => (answer.features as unknown[]).includes(f));
/** An engine call that gave no answer when the old-record road was asked for: is the engine too old to know `--no-stamps` (its argument parser refuses and prints no JSON), or is it just not answering? One plain `check` of a file
 * that does not exist tells: any engine answers it, and only a new one lists `features`. */
async function noAnswerCode(caller: OnePackCaller, probePath: string): Promise<string> {
  const probe = await caller(["check", "--bundle", probePath], CHECK_TIMEOUT_MS);
  return probe && !hasFeatures(probe, NO_STAMPS_FEATURES) ? "engine_too_old" : "engine_no_answer";
}
/** One engine call: the last JSON line decides. `null` = no answer (killed, timed out, no JSON). The default is `createOnePackCaller()`. */
export type OnePackCaller = (args: string[], timeoutMs: number) => Promise<EngineAnswer | null>;

export function lastJson(stdout: string): EngineAnswer | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    const parsed: unknown = JSON.parse(last);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { state?: unknown }).state === "string" ? parsed as EngineAnswer : null;
  } catch { return null; }
}

/** An engine answer's machine code (`reason`, a `rejectedBy` key): lower-case letters, digits and `_`, bounded. A value of another shape is not a code (desktop C item 2). */
const MACHINE_CODE = /^[a-z0-9_]{1,48}$/;
const machineCode = (value: unknown, fallback: string): string => (typeof value === "string" && MACHINE_CODE.test(value) ? value : fallback);
/** Repair 5 (engine `limit_in_answer`): what a `too_large` answer of `check` / `import` says - the size this call can take, the most a caller may declare, the size of the file it was given, and what to do (`needs`: `smaller_bundle` since engine 23091f1d,
 * `new_bundle` before it; any other code is carried as it is). Each is read on its own: a value of another shape is left out, never turned into a number. */
export interface TooLargeFacts { limitBytes?: number; maxLimitBytes?: number; bundleBytes?: number; needs?: string }
export function readTooLarge(answer: Record<string, unknown> | null | undefined): TooLargeFacts {
  if (!answer) return {};
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
  const out: TooLargeFacts = {};
  const limit = num(answer.limitBytes), max = num(answer.maxLimitBytes), bytes = num(answer.bundleBytes);
  if (limit !== undefined) out.limitBytes = limit;
  if (max !== undefined) out.maxLimitBytes = max;
  if (bytes !== undefined) out.bundleBytes = bytes;
  if (typeof answer.needs === "string" && MACHINE_CODE.test(answer.needs)) out.needs = answer.needs;
  return out;
}
/** The engine's `rejectedBy` map ("why the lines were refused": `bad_id`, `native_unsafe`, `native_too_long`, `bad_created_at`, `store_full`, and any reason a newer engine adds): every key of the code shape and every whole-number value is
 * kept as it comes; a key this desktop does not know is never dropped and never turned into something else. */
export function readRefusedBy(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>).slice(0, 64)) if (MACHINE_CODE.test(key) && typeof count === "number" && Number.isSafeInteger(count) && count > 0) out[key] = count;
  return Object.keys(out).length ? out : undefined;
}
/** How many lines the engine refused in this answer: its own `rejected` and the sum of every reason it listed, whichever is more (a reason this desktop has never seen still counts; a count is never made smaller by a missing total). */
export function refusedTotal(answer: Record<string, unknown> | null | undefined): number | undefined {
  if (!answer) return undefined;
  const said = typeof answer.rejected === "number" && Number.isSafeInteger(answer.rejected) && answer.rejected >= 0 ? answer.rejected : undefined;
  const by = readRefusedBy(answer.rejectedBy);
  const sum = by ? Object.values(by).reduce((n, c) => n + c, 0) : 0;
  return said === undefined && !by ? undefined : Math.max(said ?? 0, sum);
}

/** The real caller: `python -m agentlas_cloud.one_pack` through the desktop's one engine launcher, with the trusted owner binding. */
export function createOnePackCaller(): OnePackCaller {
  return async (args, timeoutMs) => {
    try {
      const [{ runHephaestus }, trusted] = await Promise.all([import("../hephaestus/engine"), import("../memory/trusted-owner-binding")]);
      let lease: { env: Record<string, string>; release(): void } | null = null;
      if (args[0] !== "check") {
        try { lease = trusted.retainTrustedMemoryOwnerEnvironment(); } catch { return { state: "deferred", reason: "owner_unbound" }; }
      } else {
        // `check` works without an owner (it then only reads the file); with one it also counts how many of this computer's Personal lines the stamps would blank (`wouldBlank`).
        try { lease = trusted.retainTrustedMemoryOwnerEnvironment(); } catch { lease = null; }
      }
      try {
        const result = await runHephaestus("agentlas_cloud.one_pack" as unknown as Parameters<typeof runHephaestus>[0], args, { timeoutMs, ...(lease ? { env: lease.env } : {}) });
        return lastJson(result.stdout);
      } finally { lease?.release(); }
    } catch { return null; }
  };
}

const EXPORT_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 30_000;
const IMPORT_TIMEOUT_MS = 600_000;
/** Audit 62 / what an engine call may take grows with the bundle (100 MiB: an import measured 211 s with 40,000 lines; a fixed 120 s export or 30 s check would die on a big one). Per MiB: export 2 s, check 1 s, import 5 s. */
const scaledMs = (base: number, perMiBMs: number, bytes: number): number => base + Math.ceil(Math.max(0, bytes) / (1024 * 1024)) * perMiBMs;
const PURGE_TIMEOUT_MS = 300_000;
const RETRY_PAUSE_MS = 1_000;
const MAX_ATTEMPTS = 6;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Calls an idempotent engine act until it answers with a final state: a missing answer (killed, timed out), `busy` and `remaining` are asked again, after a pause, a bounded number of times. */
async function callUntilFinal(call: OnePackCaller, args: string[], timeoutMs: number, pauseMs: number, finals: readonly string[]): Promise<EngineAnswer | null> {
  let answer: EngineAnswer | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    answer = await call(args, timeoutMs);
    if (answer && finals.includes(answer.state)) return answer;
    if (answer && ["invalid", "failed", "deferred", "no_store"].includes(answer.state)) return answer;
    if (attempt < MAX_ATTEMPTS - 1 && pauseMs > 0) await sleep(pauseMs);
  }
  return answer;
}

// --- small helpers ----------------------------------------------------------------------------------------------------------

const sha256 = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

// WHAT IT IS FOR: the marker of an owned folder records the owner process's start time (`pidStart`), so that a folder whose owner pid was REUSED by another program is not mistaken for a live owner's. A lookup that
// fails (no `wmic` on a current Windows 11, no `ps`, a PowerShell that is blocked) is `null`, and `null` never leads to a deletion: `reclaimStaleDirs` removes a folder only when the owner pid is proven gone
// (`process.kill(pid, 0)` throws ESRCH, which needs no lookup) or alive with a DIFFERENT start time that was actually read in the same format; an unreadable start time keeps the folder (the cost of "unknown" is a
// folder that stays until its pid is gone, never a folder removed under a live owner).
// Desktop repair 6: on Windows `wmic` is tried first (the format every older marker has), then PowerShell's `Get-CimInstance` (the only way left on a Windows 11 without `wmic`; its value is written `ps:<ISO time>`).
// A start time of one format is never compared with one of the other: that is "unknown" too.
export function processStartCommands(pid: number, platform: NodeJS.Platform = process.platform): Array<{ file: string; args: string[]; prefix: string }> {
  if (platform !== "win32") return [{ file: "/bin/ps", args: ["-o", "lstart=", "-p", String(pid)], prefix: "" }];
  return [
    { file: "wmic", args: ["process", "where", `ProcessId=${pid}`, "get", "CreationDate"], prefix: "" },
    { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid) | 0}').CreationDate.ToUniversalTime().ToString('o')`], prefix: "ps:" },
  ];
}
export function processStart(pid: number, run?: (file: string, args: string[]) => string, platform: NodeJS.Platform = process.platform): string | null {
  const exec = run ?? ((file: string, args: string[]) => (require("node:child_process") as typeof import("node:child_process")).execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, windowsHide: true })); // eslint-disable-line @typescript-eslint/no-require-imports
  for (const command of processStartCommands(pid, platform)) {
    try { const value = exec(command.file, command.args).trim(); if (value) return command.prefix + value; } catch { /* the next way, or null */ }
  }
  return null;
}
/** Two start times are comparable only when both came from the same kind of lookup. */
const startFormat = (value: string): string => (value.startsWith("ps:") ? "ps" : "plain");

function makeOwnedDir(base: string, prefix: string): string {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(base), prefix));
  const st = fs.lstatSync(dir);
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ kind: MARKER_KIND, pid: process.pid, pidStart: processStart(process.pid), dir, dev: st.dev, ino: st.ino, createdAt: new Date().toISOString() }), { mode: 0o600 });
  return dir;
}

function ownedDir(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8")) as { kind?: string; dir?: string; dev?: number; ino?: number };
    return st.isDirectory() && !st.isSymbolicLink() && marker.kind === MARKER_KIND && marker.dir === dir && marker.dev === st.dev && marker.ino === st.ino;
  } catch { return false; }
}

/** Remove a folder only when its marker proves this module made it. True when nothing is left. */
function removeOwned(dir: string): boolean {
  if (!ownedDir(dir)) return !fs.existsSync(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return !fs.existsSync(dir);
}

/** Removes the pack and staging folders of a crashed run under `base`: marker proven, owner process gone (or another process under the same pid). Anything unproven is kept, and so is a pack folder that is waiting for
 * its purge until it is 30 days old (`PACK_AWAITING_PURGE_KEEP_MS`): who deletes it and when: `purgePacked` when the purge is finished, `discardPacked` on cancel, this function after 30 days. */
export function reclaimStaleDirs(base: string, nowMs: number = Date.now()): { removed: string[]; kept: string[] } {
  const now = nowMs;
  const removed: string[] = [];
  const kept: string[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(base).filter((n) => n.startsWith("one-pack-") || n.startsWith("one-staged-") || n.startsWith("one-forget-")); } catch { return { removed, kept }; }
  for (const name of names) {
    const dir = path.join(fs.realpathSync(base), name);
    if (!ownedDir(dir)) { kept.push(name); continue; }
    const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8")) as { pid?: number; pidStart?: string | null; createdAt?: string };
    if (name.startsWith("one-pack-") && fs.existsSync(path.join(dir, PURGE_IDS))) {   // waiting for its purge: its owner process being gone is not enough
      const made = Date.parse(String(marker.createdAt ?? ""));
      if (!Number.isFinite(made) || now - made <= PACK_AWAITING_PURGE_KEEP_MS) { kept.push(name); continue; }
    }
    let alive = false;
    try { if (typeof marker.pid === "number") { process.kill(marker.pid, 0); alive = true; } } catch (error) { alive = (error as NodeJS.ErrnoException).code === "EPERM"; }
    const startNow = alive && marker.pidStart ? processStart(marker.pid as number) : null;
    if (alive && (!marker.pidStart || startNow === null || startNow === marker.pidStart || startFormat(startNow) !== startFormat(marker.pidStart))) { kept.push(name); continue; }
    (removeOwned(dir) ? removed : kept).push(name);
  }
  return { removed, kept };
}

// --- the conversation -------------------------------------------------------------------------------------------------------

export interface ConversationLine { id: string; role: "user" | "assistant" | "system"; text: string; createdAt: string; kind?: string; hostNotice?: unknown }
/** What `parseConversation` hands to the import: the lines as read (a `system` line is kept here only so that it can be counted; the import never stores it) and how many notices were stripped. */
interface ParsedConversation { lines: ConversationLine[]; noticesStripped: number; /** lines left out: a date that is not an ISO date or lies in the future (audit 59 F-12) */ droppedBadDate: number; /** the oldest lines left out beyond `CONVERSATION_LINES_MAX` */ droppedOver: number }

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function columnsOf(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}

/** The chat the personal agent is bound to on this computer, or null (no binding: never moved in, or already moved out). */
export function boundPersonalChat(db: Database.Database, oneId: string): string | null {
  if (!hasTable(db, "one_supervisor_conversations")) return null;
  const row = db.prepare("SELECT chat_id FROM one_supervisor_conversations WHERE one_id=?").get(oneId) as { chat_id?: string } | undefined;
  return row?.chat_id ?? null;
}

/** The text of the personal conversation, oldest first. Only what the owner and the agent said: no attachment, no photo, no runtime-input twin. */
export function readConversation(db: Database.Database, chatId: string): ConversationLine[] {
  if (!hasTable(db, "chat_messages")) return [];
  const columns = columnsOf(db, "chat_messages");
  const select = ["id", "role", "text", "created_at", columns.has("host_notice_json") ? "host_notice_json" : "NULL AS host_notice_json", columns.has("row_scope") ? "row_scope" : "NULL AS row_scope"];
  const scope = columns.has("row_scope") ? " AND (row_scope IS NULL OR row_scope='view')" : "";
  const rows = db.prepare(`SELECT ${select.join(",")} FROM chat_messages WHERE chat_id=? AND text<>''${scope} ORDER BY created_at, rowid`).all(chatId) as Array<{ id: string; role: string; text: string; created_at: string; host_notice_json: string | null; row_scope: string | null }>;
  const lines: ConversationLine[] = [];
  for (const r of rows) {
    if (!MESSAGE_ID.test(r.id) || (r.role !== "user" && r.role !== "assistant" && r.role !== "system") || r.text.length > LINE_TEXT_MAX) continue;
    const line: ConversationLine = { id: r.id, role: r.role, text: r.text, createdAt: r.created_at };
    if (r.row_scope === "view") line.kind = "view";
    const notice = parseChatHostNotice(r.role, r.host_notice_json);
    if (notice) line.hostNotice = notice;
    lines.push(line);
  }
  return lines;
}

function lineBytes(lines: ConversationLine[]): Buffer {
  return Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""), "utf8");
}

function parseConversation(bytes: Buffer): ParsedConversation | null {
  const lines: ConversationLine[] = [];
  let noticesStripped = 0, droppedBadDate = 0;
  const seen = new Set<string>();
  const text = bytes.toString("utf8");
  const now = Date.now();
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return null; }
    const v = value as Partial<ConversationLine> | null;
    if (!v || typeof v !== "object" || typeof v.id !== "string" || !MESSAGE_ID.test(v.id) || seen.has(v.id)
      || (v.role !== "user" && v.role !== "assistant" && v.role !== "system") || typeof v.text !== "string" || !v.text || v.text.length > LINE_TEXT_MAX
      || typeof v.createdAt !== "string" || !v.createdAt) return null;
    seen.add(v.id);
    if (!createdAtOk(v.createdAt, now)) { droppedBadDate += 1; continue; }   // never stored: a forged far-future date would stay at the end of the personal conversation for good
    if (v.hostNotice !== undefined) noticesStripped += 1;   // never stored: the line comes in as plain text (a notice marks the host's own lines; a bundle cannot make one)
    lines.push({ id: v.id, role: v.role, text: v.text, createdAt: v.createdAt, ...(v.kind === "view" ? { kind: "view" } : {}) });
  }
  const droppedOver = Math.max(0, lines.length - CONVERSATION_LINES_MAX);
  return { lines: droppedOver ? lines.slice(droppedOver) : lines, noticesStripped, droppedBadDate, droppedOver };
}

export interface ConversationImport { state: "imported" | "no_personal_chat"; inserted: number; alreadyThere: number; elsewhere: number; /** `system` lines left out */ droppedSystem: number; /** host notices left off */ noticesStripped: number;
  /** lines left out because their date was not an ISO date or lay in the future, and the oldest lines beyond the line limit (F-12) */ droppedBadDate?: number; droppedOver?: number }

/** Puts the bundle's lines into the personal conversation of this computer (the one bound now, or the one `ensureChat` makes), by id, never overwriting and never deleting. A `system` line is not stored (it is
 * counted); a `hostNotice` is never stored (`noticesStripped` says how many lines had one). Nothing is bound because of what the ids match: a message id that lives in another chat of this computer is
 * left alone and counted in `elsewhere`, and the conversation this computer had before it moved away (when O-M3 keeps one as "before the move") is not bound again by this function. */
export function importConversation(db: Database.Database, oneId: string, lines: ConversationLine[], ensureChat?: () => string | null, noticesStripped = 0, dropped: { badDate?: number; over?: number } = {}, inside?: () => void): ConversationImport {
  const extra = { ...(dropped.badDate ? { droppedBadDate: dropped.badDate } : {}), ...(dropped.over ? { droppedOver: dropped.over } : {}) };
  const run = db.transaction((): ConversationImport => {
    const ids = lines.map((l) => l.id);
    const where = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      for (const r of db.prepare(`SELECT id, chat_id FROM chat_messages WHERE id IN (${part.map(() => "?").join(",")})`).all(...part) as Array<{ id: string; chat_id: string }>) where.set(r.id, r.chat_id);
    }
    let chat = boundPersonalChat(db, oneId);
    if (!chat) {
      chat = ensureChat?.() ?? null;
      if (chat) chat = boundPersonalChat(db, oneId) ?? chat;
    }
    const droppedSystem = lines.filter((l) => l.role === "system").length;
    if (!chat) return { state: "no_personal_chat", inserted: 0, alreadyThere: 0, elsewhere: 0, droppedSystem, noticesStripped, ...extra };
    const columns = columnsOf(db, "chat_messages");
    const names = ["id", "chat_id", "role", "text", "created_at", ...(columns.has("host_notice_json") ? ["host_notice_json"] : []), ...(columns.has("row_scope") ? ["row_scope"] : [])];
    const insert = db.prepare(`INSERT OR IGNORE INTO chat_messages(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`);
    let inserted = 0, alreadyThere = 0, elsewhere = 0;
    for (const l of lines) {
      if (l.role === "system") continue;   // counted above, never stored
      const at = where.get(l.id);
      if (at === chat) { alreadyThere += 1; continue; }
      if (at !== undefined) { elsewhere += 1; continue; }   // the same id lives in another chat of this computer: left alone (a message id belongs to one chat)
      const values: unknown[] = [l.id, chat, l.role, l.text, l.createdAt];
      if (columns.has("host_notice_json")) values.push(null);
      if (columns.has("row_scope")) values.push(l.kind === "view" ? "view" : null);
      inserted += insert.run(...values).changes;
    }
    inside?.();   // TH+MT audit D2: what must stand or fall with the words (their turn links) runs in this transaction; a throw takes the words back too
    return { state: "imported", inserted, alreadyThere, elsewhere, droppedSystem, noticesStripped, ...extra };
  });
  return run.immediate();
}

// --- manifest ---------------------------------------------------------------------------------------------------------------

export interface BundleManifest {
  schema: typeof BUNDLE_SCHEMA;
  packId: string;
  createdAt: string;
  files: Record<string, { bytes: number; sha256: string }>;
  counts: { messages: number; memoryRows: number; stamps: number; checkins: number };
  droppedEmbeddings: boolean;
  droppedMessages: number;
}

function readManifest(dir: string): BundleManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Partial<BundleManifest>;
    if (raw.schema !== BUNDLE_SCHEMA || typeof raw.packId !== "string" || !/^pk_[0-9a-f]{32}$/.test(raw.packId) || !raw.files || typeof raw.files !== "object" || !raw.counts) return null;
    return raw as BundleManifest;
  } catch { return null; }
}

// --- pack -------------------------------------------------------------------------------------------------------------------

export interface PackResult {
  state: "packed" | "failed";
  code?: string;
  dir?: string;
  packId?: string;
  manifest?: BundleManifest;
  /** The files to send (the manifest's), as absolute paths. `purge-ids.json` is not among them. */
  uploadFiles?: string[];
  bytes?: number;
  /** Personal lines the engine left out because the receiving engine would refuse them (secret shape, too long, a kind a Personal store does not take, not text): the count and the reasons, NEVER the text.
   * They stay on this computer (they are not in the purge list). The caller shows the owner this number; the lines are not in the bundle. */
  notPacked?: { count: number; byReason: Record<string, number> };
  /** Forget stamps left out because the bundle holds at most the newest 5000: the words of those older forgets can be learned again on the new computer. */
  stampsNotPacked?: number;
  /** Repair 5 (engine `priority_order`): how many lines of each kind tier were packed (`packedBy`) and, for a store that did not fit, how many were left (`leftBy`): tier name -> count. Counts only; a tier name this desktop has never seen is kept as it comes. */
  packedBy?: Record<string, number>; leftBy?: Record<string, number>;
  /** Repair 5 (engine `limit_in_answer`): on `store_too_large` the size the engine's own check said it can take - the caller packs again under it (once per smaller size), never again at the same size. */
  limitBytes?: number;
}

function jsonBytes(value: unknown): Buffer { return Buffer.from(JSON.stringify(value), "utf8"); }
function cleanNames(list: unknown): string[] {
  return Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === "string" && x.trim().length > 0 && x.length <= 128).map((x) => x.trim()))].slice(0, NAME_LIST_MAX) : [];
}

/** The files of a bundle that are not the memory file (conversation, profile, avatar, check-ins, settings, names, seed) and the room that is left for the memory file (`budget`). Reads; writes nothing. */
function readSmallParts(host: BundleHost, maxBytes: number): { lines: ConversationLine[]; small: Record<string, Buffer>; fixed: number; convo: Buffer; budget: number; checkins: BundleCheckin[] } {
    const chat = boundPersonalChat(host.db, host.oneId);
    let lines = chat ? readConversation(host.db, chat) : [];
    const small: Record<string, Buffer> = {};
    const profile = host.profile?.() ?? null;
    if (profile) small["profile.json"] = jsonBytes(profile);
    const avatar = host.avatar?.() ?? null;
    if (avatar && avatar.length > 0 && avatar.length <= AVATAR_MAX_BYTES) small["avatar.bin"] = avatar;
    const checkins = host.checkins?.read() ?? [];
    if (checkins.length) small["checkins.jsonl"] = Buffer.from(checkins.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8");
    const settings = host.settings?.() ?? null;
    if (settings) small["settings.json"] = jsonBytes(settings);
    const names = host.reconnect?.() ?? null;
    if (names) small["reconnect.json"] = jsonBytes({ providers: cleanNames(names.providers), appKeys: cleanNames(names.appKeys), mcpServers: cleanNames(names.mcpServers) });
    const turns: SeedTurn[] = lines.filter((l) => l.role !== "system").slice(-CONTEXT_SEED_TURNS).map((l) => ({ role: l.role as "user" | "assistant", text: l.text.slice(0, SEED_TEXT_MAX), createdAt: l.createdAt }));
    small["context-seed.json"] = jsonBytes({ schema: BUNDLE_SCHEMA, turns });
    for (const [name, bytes] of Object.entries(small)) if (name !== "avatar.bin" && bytes.length > SMALL_FILE_MAX) delete small[name];   // a runaway small file is left out, never refused
    const fixed = Object.values(small).reduce((n, b) => n + b.length, 0) + 4_096;
    let convo = lineBytes(lines);
    const budget = Math.max(1, maxBytes - fixed - convo.length);
    return { lines, small, fixed, convo, budget, checkins };
}

/**
 * Audit 62 / + (engine `c897da3e`, `partial_export`): the packing ORDER is the priority. 1. the small files (profile, principles, check-ins, settings, `context-seed.json`) always; 2. the memory, by the engine's own priority, with
 * `--limit-bytes` = the limit minus 1 (this function); 3. the personal conversation with the bytes that are left, newest lines first (`packOne` drops its oldest lines when memory + small files + conversation exceed the limit). The conversation never takes
 * the memory's room. The same value goes to `measure` and to `export`.
 */
export function memoryRoomBytes(host: BundleHost, maxBytes: number = BUNDLE_LEGACY_LIMIT_BYTES): number {
  const { fixed } = readSmallParts(host, maxBytes);
  return Math.max(1, maxBytes - fixed);
}

export interface MeasureResult {
  /** `fits`: the engine measured and the memory file will fit. `too_large`: it will not (nothing may be sealed). `no_store`: nothing to move.
   * Audit 62 (home D5): `unsupported` = an engine without `measure` (the caller goes on as before). `no_answer` = the engine did not answer, `deferred` = it answered it cannot say yet (`reason`, a code), `unknown` = a measure that could not even be asked
   * (local read failed): the caller does NOT seal for these three - the home stays open and the step waits with the code. */
  state: "fits" | "too_large" | "no_store" | "unknown" | "unsupported" | "no_answer" | "deferred" | "no_room" | "partial";
  /** The engine's `features` as listed in this answer (internal), the limit this move may carry and whether the engine takes `--limit-bytes` in every command (`limit_100mib`). */
  effectiveLimit?: number; engine100?: boolean;
  /** `partial`: the memory does not fit whole; `rows` are carried, `leftRows` stay on this computer (`notPackedBy.over_size_limit`). `limitBytes` is the room given to the engine: pack with the same value. */
  leftRows?: number;
  reason?: string;
  /** Audit 62 (engine `measure_out`): the folder the bundle is written to cannot take it (`no_room`: `outFreeBytes` is what it has; `out_unwritable`): nothing is sealed - a full disk is the owner's to clear, and says how many bytes. */
  outFreeBytes?: number;
  rows?: number; estimatedBytes?: number; limitBytes?: number; notPackedBy?: Record<string, number>;
}
/** Audit 61 desktop 1: BEFORE anything is sealed, asks the engine (read only, no file) whether the memory file will fit the bundle. The same room `packOne` gives it (what the small files and the conversation leave). */
export async function measureOne(host: BundleHost, options: { caller: OnePackCaller; /** the limit WANTED for this move (default: the 100 MiB one); an engine without `limit_100mib` is measured and packed for at the legacy limit whatever is asked */ maxBytes?: number; /** the pack folder's parent: the engine says whether a bundle fits THERE (`measure --out`) */ outDir?: string }): Promise<MeasureResult> {
  // Audit 62 / ask at the legacy limit first (every engine knows it); an engine that lists `limit_100mib` is asked again at the wanted limit. `effectiveLimit` is what this move may carry; `engine100` says the engine takes `--limit-bytes` in `check` / `import` as well.
  const wanted = options.maxBytes ?? BUNDLE_LIMIT_BYTES;
  const seen: { features?: string[] } = {};
  // Repair 5 / E-3: a move may be wanted BELOW the legacy limit (the receiver said it can take less): every engine measures at that, and the answer's `effectiveLimit` is what was measured.
  const firstLimit = Math.min(wanted, BUNDLE_LEGACY_LIMIT_BYTES);
  const first = await measureAt(host, options, firstLimit, seen);
  const knows100 = seen.features?.includes("limit_100mib") === true;
  if (!knows100 || wanted <= BUNDLE_LEGACY_LIMIT_BYTES) return { ...first, effectiveLimit: firstLimit, engine100: knows100 };
  const big = await measureAt(host, options, wanted, seen);
  return { ...big, effectiveLimit: wanted, engine100: true };
}
async function measureAt(host: BundleHost, options: { caller: OnePackCaller; outDir?: string }, maxBytes: number, seen: { features?: string[] }): Promise<MeasureResult> {
  let budget: number;
  try { budget = readSmallParts(host, maxBytes).budget; } catch { return { state: "unknown" }; }
  const baseWith = (limit: number): string[] => ["measure", "--budget-bytes", String(budget), "--limit-bytes", String(limit)];
  const base = baseWith(maxBytes);
  let answer = options.outDir ? await options.caller([...base, "--out", options.outDir], CHECK_TIMEOUT_MS) : null;
  if (!answer) answer = await options.caller(base, CHECK_TIMEOUT_MS);   // an engine from before `--out` refuses it and prints no JSON: the plain measure
  if (!answer) {
    // An engine from before `measure` refuses the command and prints no JSON, exactly as an engine that is not answering does: one plain `check` of a file that does not exist tells them apart (any engine answers it).
    const probe = await options.caller(["check", "--bundle", path.join("one-measure-probe", "none.sqlite")], CHECK_TIMEOUT_MS);
    return probe && !(Array.isArray(probe.features) && (probe.features as unknown[]).includes("measure")) ? { state: "unsupported" } : { state: "no_answer" };   // it knows `measure` yet did not answer it: not an old engine
  }
  if (Array.isArray(answer.features)) seen.features = (answer.features as unknown[]).filter((f): f is string => typeof f === "string");
  if (!Array.isArray(answer.features) && answer.state !== "deferred") return { state: "unsupported" };   // an engine from before `measure` does not know the command and answers something else
  if (answer.state === "deferred" || answer.state === "failed") return { state: "deferred", reason: typeof answer.reason === "string" && /^[a-z0-9_]{1,48}$/.test(answer.reason) ? answer.reason : "unknown" };
  if (Array.isArray(answer.features) && !(answer.features as unknown[]).includes("measure")) return { state: "unsupported" };
  if (answer.state === "no_store") return { state: "no_store" };
  if (answer.state !== "measured" || typeof answer.fits !== "boolean") return { state: "unknown" };
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
  if (answer.fits === true && answer.outWritable === false) return { state: "no_room", reason: "out_unwritable", ...(num(answer.estimatedBytes) !== undefined ? { estimatedBytes: num(answer.estimatedBytes) } : {}) };
  if (answer.fits === true && answer.outRoom === false) return { state: "no_room", reason: "disk_space", ...(num(answer.outFreeBytes) !== undefined ? { outFreeBytes: num(answer.outFreeBytes) } : {}), ...(num(answer.estimatedBytes) !== undefined ? { estimatedBytes: num(answer.estimatedBytes) } : {}) };
  const by = readRefusedBy(answer.notPackedBy);
  // an engine that lists `partial_export` answers a store that does not fit with what `export` WOULD carry (`partial: true`) - asked again with the memory room (the limit minus what the desktop packs beside it). `rows: 0` = nothing can be carried: the old end.
  if (Array.isArray(answer.features) && (answer.features as unknown[]).includes("partial_export") && answer.fits !== true) {
    const room = (() => { try { return memoryRoomBytes(host, maxBytes); } catch { return null; } })();
    let a2: EngineAnswer | null = answer;
    if (room !== null) a2 = await options.caller([...baseWith(room), ...(options.outDir ? ["--out", options.outDir] : [])], CHECK_TIMEOUT_MS) ?? answer;
    if (a2 && a2.state === "measured" && a2.partial === true && room !== null) {
      const by2 = readRefusedBy(a2.notPackedBy); const carried = num(a2.rows) ?? 0;
      if (carried > 0) return { state: "partial", rows: carried, leftRows: by2?.over_size_limit ?? 0, ...(num(a2.estimatedBytes) !== undefined ? { estimatedBytes: num(a2.estimatedBytes) } : {}), limitBytes: room, ...(by2 ? { notPackedBy: by2 } : {}) };
      return { state: "too_large", rows: 0, leftRows: by2?.over_size_limit ?? 0, ...(num(a2.estimatedBytes) !== undefined ? { estimatedBytes: num(a2.estimatedBytes) } : {}), limitBytes: room };
    }
  }
  return { state: answer.fits ? "fits" : "too_large", ...(num(answer.rows) !== undefined ? { rows: num(answer.rows) } : {}), ...(num(answer.estimatedBytes) !== undefined ? { estimatedBytes: num(answer.estimatedBytes) } : {}),
    ...(num(answer.limitBytes) !== undefined ? { limitBytes: num(answer.limitBytes) } : {}), ...(by ? { notPackedBy: by } : {}) };
}

/**
 * Audit 62 (home D4, engine `f9643740`): can this computer take an import AT ALL, asked before a move starts and before the receiver commits (read only, no bundle). `blockers` are codes and host names only (never a path, never text):
 * `needs` says what has to change OUTSIDE (`plugin_update`, `owner_bind`, `store_repair`, `permission`...). `unsupported` = an engine from before `ready` (the old road: nothing can be known before the commit); `no_answer` = the engine did not answer.
 */
export interface ReadyBlocker {
  reason: string; needs: string; hosts?: string[];
  /** Repair 5 (engine `ready_room`): asked again the engine answers differently (a store a writer holds right now: `store_busy`). Such a blocker has no `needs` of its own: `needs` is `retry`. */
  retryable?: boolean;
  /** `disk_space_short`: the bytes free on the disk the store lives on and the bytes the import needs (numbers only). */
  freeBytes?: number; needBytes?: number;
}
export interface ReadyResult { state: "ready" | "not_ready" | "unsupported" | "no_answer"; blockers: ReadyBlocker[]; enginesNotConfirmed?: number; /** the engine lists `limit_100mib`: `check` and `import` take `--limit-bytes` */ engine100?: boolean;
  /** Repair 5: the engine lists `ready_room` (it knows `--need-bytes`, `store_busy` and `disk_space_short`); `freeBytes` / `needBytes` are in its answer only when it was asked with `--need-bytes`. */
  room?: boolean; freeBytes?: number; needBytes?: number }
const CODE_RE = /^[a-z0-9_]{1,48}$/;
const HOST_RE = /^[A-Za-z0-9_.\- ]{1,32}$/;
/** `needBytes`: the room an import needs (a number, or a function of whether the engine knows 100 MiB: a bundle may be that big). It is passed to the engine ONLY when the engine lists `ready_room` - an older engine does not know the argument and would answer nothing - so the first call never carries it. */
export async function readyOne(caller: OnePackCaller, engineRoots: readonly string[] = [], options: { needBytes?: number | ((engine100: boolean) => number) } = {}): Promise<ReadyResult> {
  const args = ["ready", ...engineRoots.flatMap((r) => ["--engine", r])];
  let answer = await caller(args, CHECK_TIMEOUT_MS);
  if (!answer) {
    const probe = await caller(["check", "--bundle", path.join("one-ready-probe", "none.sqlite")], CHECK_TIMEOUT_MS);
    return probe && !(Array.isArray(probe.features) && (probe.features as unknown[]).includes("ready")) ? { state: "unsupported", blockers: [] } : { state: "no_answer", blockers: [] };
  }
  if (answer.state === "deferred") return { state: "not_ready", blockers: [{ reason: typeof answer.reason === "string" && CODE_RE.test(answer.reason) ? answer.reason : "owner_unbound", needs: "owner_bind" }] };
  if (!Array.isArray(answer.features) || !(answer.features as unknown[]).includes("ready")) return { state: "unsupported", blockers: [] };
  const engine100 = (answer.features as unknown[]).includes("limit_100mib");
  const room = (answer.features as unknown[]).includes("ready_room");
  const wanted = typeof options.needBytes === "function" ? options.needBytes(engine100) : options.needBytes;
  if (room && typeof wanted === "number" && Number.isFinite(wanted) && wanted > 0) {
    const asked = await caller([...args, "--need-bytes", String(Math.floor(wanted))], CHECK_TIMEOUT_MS);
    if (asked && Array.isArray(asked.features) && (asked.state === "ready" || asked.state === "not_ready")) answer = asked;   // no answer to the second question: the first one stands (the disk is simply not looked at)
  }
  const whole = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
  const roomFacts = { ...(room ? { room: true } : {}), ...(whole(answer.freeBytes) !== undefined ? { freeBytes: whole(answer.freeBytes) } : {}), ...(whole(answer.needBytes) !== undefined ? { needBytes: whole(answer.needBytes) } : {}) };
  if (answer.state === "ready") return { state: "ready", blockers: [], engine100, ...roomFacts };
  if (answer.state !== "not_ready") return { state: "no_answer", blockers: [] };
  const raw = Array.isArray(answer.blockers) ? answer.blockers as unknown[] : [];
  const blockers: ReadyBlocker[] = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    const hosts = Array.isArray(b.hosts) ? (b.hosts as unknown[]).filter((h): h is string => typeof h === "string" && HOST_RE.test(h)).slice(0, 8) : [];
    const retryable = b.retryable === true;
    blockers.push({ reason: typeof b.reason === "string" && CODE_RE.test(b.reason) ? b.reason : "unknown", needs: typeof b.needs === "string" && CODE_RE.test(b.needs) ? b.needs : retryable ? "retry" : "unknown", ...(hosts.length ? { hosts } : {}),
      ...(retryable ? { retryable: true } : {}), ...(whole(b.freeBytes) !== undefined ? { freeBytes: whole(b.freeBytes) } : {}), ...(whole(b.needBytes) !== undefined ? { needBytes: whole(b.needBytes) } : {}) });
  }
  if (!blockers.length) blockers.push({ reason: "unknown", needs: "unknown" });
  return { state: "not_ready", engine100, ...roomFacts, blockers, ...(Number.isSafeInteger(answer.enginesNotConfirmed) ? { enginesNotConfirmed: answer.enginesNotConfirmed as number } : {}) };
}

/** Packs the personal agent. Reads the app database and the engine's store and writes only into a new folder under `workDir`; deletes nothing (the old copy goes in `purgePacked`, later). */
export async function packOne(host: BundleHost, options: { workDir: string; caller: OnePackCaller; maxBytes?: number; /** O54: the engine lists `limit_100mib`: its `check` gets `--limit-bytes` too */ engine100?: boolean; /** O53: the memory room (`memoryRoomBytes`) given to `measure`; only for an engine that lists `partial_export` */ limitBytes?: number; /** the old-record road: carry no forget stamp (audit 59 B1) */ noStamps?: boolean }): Promise<PackResult> {
  const maxBytes = options.maxBytes ?? BUNDLE_LEGACY_LIMIT_BYTES;
  const dir = makeOwnedDir(options.workDir, "one-pack-");
  try {
    let { lines, small, fixed, convo, budget, checkins } = readSmallParts(host, maxBytes);
    const stampArg = options.noStamps ? ["--no-stamps"] : [];
    const memory = await options.caller(["export", "--out", path.join(dir, "memory.sqlite"), "--ids-out", path.join(dir, PURGE_IDS), "--budget-bytes", String(budget), ...(options.limitBytes ? ["--limit-bytes", String(options.limitBytes)] : []), ...stampArg], scaledMs(EXPORT_TIMEOUT_MS, 2_000, maxBytes));
    if (!memory) return { state: "failed", code: options.noStamps ? await noAnswerCode(options.caller, path.join(dir, "no-such-bundle.sqlite")) : "engine_no_answer" };
    if (options.noStamps && !hasFeatures(memory, NO_STAMPS_FEATURES)) return { state: "failed", code: "engine_too_old" };   // an engine that answered without knowing the road must not have packed stamps
    if (memory.state !== "packed" && memory.state !== "no_store") return { state: "failed", code: `engine_${memory.state}${memory.reason ? "_" + String(memory.reason) : ""}` };
    const memoryBytes = memory.state === "packed" ? Number(memory.bytes ?? 0) : 0;
    // Over the limit even without embeddings: the oldest conversation lines go first. Never a refusal.
    let dropped = 0;
    if (memoryBytes + fixed + convo.length > maxBytes) {
      const room = Math.max(0, maxBytes - memoryBytes - fixed);
      let keepFrom = 0;
      let total = convo.length;
      while (total > room && keepFrom < lines.length) { total -= Buffer.byteLength(JSON.stringify(lines[keepFrom]), "utf8") + 1; keepFrom += 1; }
      dropped = keepFrom;
      lines = lines.slice(keepFrom);
      convo = lineBytes(lines);
    }
    small["conversation.jsonl"] = convo;
    for (const [name, bytes] of Object.entries(small)) fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o600 });
    const verdict = memory.state === "packed" ? await options.caller(["check", "--bundle", path.join(dir, "memory.sqlite"), ...stampArg, ...(options.engine100 ? ["--limit-bytes", String(maxBytes)] : [])], scaledMs(CHECK_TIMEOUT_MS, 1_000, maxBytes)) : null;
    // Audit 61 desktop 1: a memory file over the size limit is its own code (an engine without `measure` finds out only here): the caller unseals at once.
    if (memory.state === "packed" && verdict?.state === "invalid" && verdict.reason === "too_large") return { state: "failed", code: "store_too_large", ...(readTooLarge(verdict).limitBytes !== undefined ? { limitBytes: readTooLarge(verdict).limitBytes } : {}) };
    if (memory.state === "packed" && verdict?.state !== "ok") return { state: "failed", code: "engine_check_failed" };
    const packId = typeof verdict?.packId === "string" && /^pk_[0-9a-f]{32}$/.test(verdict.packId) ? verdict.packId : `pk_${crypto.randomBytes(16).toString("hex")}`;
    const files: BundleManifest["files"] = {};
    for (const name of BUNDLE_FILES) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) continue;
      const bytes = fs.readFileSync(p);
      files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
    }
    const manifest: BundleManifest = {
      schema: BUNDLE_SCHEMA, packId, createdAt: new Date().toISOString(), files,
      counts: { messages: lines.length, memoryRows: Number(memory.rows ?? 0), stamps: Number(memory.stamps ?? 0), checkins: checkins.length },
      droppedEmbeddings: memory.state === "packed" && memory.embeddings === false, droppedMessages: dropped,
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    const uploadFiles = [...Object.keys(files), "manifest.json"].map((n) => path.join(dir, n));
    const notPackedCount = Number(memory.notPacked ?? 0);
    const notPackedBy: Record<string, number> = {};
    if (memory.notPackedBy && typeof memory.notPackedBy === "object") for (const [k, v] of Object.entries(memory.notPackedBy as Record<string, unknown>)) if (typeof v === "number" && /^[a-z_]{1,32}$/.test(k)) notPackedBy[k] = v;
    return { state: "packed", dir, packId, manifest, uploadFiles, bytes: Object.values(files).reduce((n, f) => n + f.bytes, 0),
      ...(notPackedCount > 0 ? { notPacked: { count: notPackedCount, byReason: notPackedBy } } : {}),
      ...(Number(memory.stampsNotPacked ?? 0) > 0 ? { stampsNotPacked: Number(memory.stampsNotPacked) } : {}),
      ...(readRefusedBy(memory.packedBy) ? { packedBy: readRefusedBy(memory.packedBy) } : {}), ...(readRefusedBy(memory.leftBy) ? { leftBy: readRefusedBy(memory.leftBy) } : {}) };
  } catch (error) {
    return { state: "failed", code: `pack_${(error as NodeJS.ErrnoException)?.code ?? "error"}` };
  } finally {
    // A failed pack leaves nothing; a finished one is deleted by purgePacked / discardPacked.
    if (!fs.existsSync(path.join(dir, "manifest.json"))) removeOwned(dir);
  }
}

/** Cancel or failure of a move: deletes the pack folder (it holds a copy of the conversation text). Touches nothing in the store. */
export function discardPacked(dir: string): boolean { return removeOwned(dir); }

// --- stage and check --------------------------------------------------------------------------------------------------------

export interface StageResult { state: "staged" | "invalid"; code?: string; dir?: string; packId?: string }

function verifyFolder(dir: string): { code: string } | { manifest: BundleManifest } {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { code: "folder_unreadable" }; }
  const allowed = new Set<string>([...BUNDLE_FILES, "manifest.json", MARKER, PURGE_IDS]);
  for (const e of entries) {
    if (!allowed.has(e.name)) return { code: "file_not_allowed" };     // photos, attachments, anything not in the list
    if (!e.isFile()) return { code: "not_a_plain_file" };
  }
  const manifest = readManifest(dir);
  if (!manifest) return { code: "manifest_invalid" };
  let total = 0;
  for (const name of Object.keys(manifest.files)) if (!(BUNDLE_FILES as readonly string[]).includes(name)) return { code: "file_not_allowed" };
  for (const e of entries) {
    if (e.name === "manifest.json" || e.name === MARKER || e.name === PURGE_IDS) continue;
    if (!manifest.files[e.name]) return { code: "file_not_in_manifest" };
  }
  // Sizes first: the size on disk is measured before any file is read, so a bundle that is far over the limit is refused without being read into memory.
  for (const [name, expect] of Object.entries(manifest.files)) {
    let size: number;
    try { size = fs.lstatSync(path.join(dir, name)).size; } catch { return { code: "file_missing" }; }
    if (size !== expect.bytes) return { code: "file_changed" };
    total += size;
  }
  if (!manifest.files["conversation.jsonl"]) return { code: "conversation_missing" };
  if (total > BUNDLE_MAX_BYTES + BUNDLE_SLACK_BYTES) return { code: "too_large_unlisted" };   // the sender trims to the limit; this only catches a bundle that was not made by packOne
  for (const [name, expect] of Object.entries(manifest.files)) {
    let bytes: Buffer;
    try { bytes = fs.readFileSync(path.join(dir, name)); } catch { return { code: "file_missing" }; }
    if (bytes.length !== expect.bytes || sha256(bytes) !== expect.sha256) return { code: "file_changed" };
  }
  return { manifest };
}

/** Copies a downloaded bundle folder into a new owned staging folder after checking its file list and hashes. The source is left as it is (the caller deletes its own download). */
export function stageBundle(sourceDir: string, options: { stagingBase: string }): StageResult {
  const first = verifyFolder(sourceDir);
  if ("code" in first) return { state: "invalid", code: first.code };
  const dir = makeOwnedDir(options.stagingBase, "one-staged-");
  try {
    for (const name of [...Object.keys(first.manifest.files), "manifest.json"]) fs.copyFileSync(path.join(sourceDir, name), path.join(dir, name));
    const again = verifyFolder(dir);
    if ("code" in again) { removeOwned(dir); return { state: "invalid", code: again.code }; }
    return { state: "staged", dir, packId: first.manifest.packId };
  } catch (error) {
    removeOwned(dir);
    return { state: "invalid", code: `stage_${(error as NodeJS.ErrnoException)?.code ?? "error"}` };
  }
}

export function discardStaged(dir: string): boolean { return removeOwned(dir); }

export interface StagedParts {
  manifest: BundleManifest;
  conversation: ConversationLine[];
  noticesStripped: number;
  droppedBadDate: number;
  droppedOver: number;
  seed: SeedTurn[];
  profile: Record<string, unknown> | null;
  avatar: Buffer | null;
  checkins: BundleCheckin[];
  settings: Record<string, unknown> | null;
  reconnect: ReconnectNames | null;
}

function readSmallJson(dir: string, name: string): { ok: true; value: unknown } | { ok: false } | { ok: true; value: null } {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return { ok: true, value: null };
  try { return { ok: true, value: JSON.parse(fs.readFileSync(p, "utf8")) }; } catch { return { ok: false }; }
}

function readParts(dir: string): StagedParts | { code: string } {
  const verified = verifyFolder(dir);
  if ("code" in verified) return verified;
  const parsed = parseConversation(fs.readFileSync(path.join(dir, "conversation.jsonl")));
  if (!parsed) return { code: "conversation_invalid" };
  const conversation = parsed.lines;
  const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
  const profile = readSmallJson(dir, "profile.json"), settings = readSmallJson(dir, "settings.json"), reconnect = readSmallJson(dir, "reconnect.json"), seedJson = readSmallJson(dir, "context-seed.json");
  if (!profile.ok || !settings.ok || !reconnect.ok || !seedJson.ok) return { code: "json_invalid" };
  if (profile.value !== null && !obj(profile.value)) return { code: "profile_invalid" };
  if (settings.value !== null && !obj(settings.value)) return { code: "settings_invalid" };
  let recon: ReconnectNames | null = null;
  if (reconnect.value !== null) {
    const r = obj(reconnect.value);
    if (!r) return { code: "reconnect_invalid" };
    recon = { providers: cleanNames(r.providers), appKeys: cleanNames(r.appKeys), mcpServers: cleanNames(r.mcpServers) };   // names only: any other key is dropped
  }
  const seedTurns = obj(seedJson.value)?.turns;
  const seed: SeedTurn[] = Array.isArray(seedTurns)
    ? seedTurns.flatMap((t) => { const v = obj(t); return v && (v.role === "user" || v.role === "assistant") && typeof v.text === "string" && typeof v.createdAt === "string" ? [{ role: v.role, text: v.text.slice(0, SEED_TEXT_MAX), createdAt: v.createdAt } as SeedTurn] : []; }).slice(-CONTEXT_SEED_TURNS)
    : [];
  const checkins: BundleCheckin[] = [];
  const cp = path.join(dir, "checkins.jsonl");
  if (fs.existsSync(cp)) {
    if (fs.lstatSync(cp).size > SMALL_FILE_MAX) return { code: "checkins_too_large" };   // the sender leaves a runaway small file out (packOne), so a file this large was not made by it (F-4)
    for (const raw of fs.readFileSync(cp, "utf8").split("\n")) {
      if (!raw) continue;
      let v: unknown;
      try { v = JSON.parse(raw); } catch { return { code: "checkins_invalid" }; }
      const o = obj(v);
      if (!o || typeof o.id !== "string" || !o.id) return { code: "checkins_invalid" };
      checkins.push(o as BundleCheckin);
    }
  }
  const ap = path.join(dir, "avatar.bin");
  const avatar = fs.existsSync(ap) ? fs.readFileSync(ap) : null;
  if (avatar && avatar.length > AVATAR_MAX_BYTES) return { code: "avatar_too_large" };
  return { manifest: verified.manifest, conversation, noticesStripped: parsed.noticesStripped, droppedBadDate: parsed.droppedBadDate, droppedOver: parsed.droppedOver, seed, profile: obj(profile.value), avatar, checkins, settings: obj(settings.value), reconnect: recon };
}

export interface CheckResult {
  state: "ok" | "invalid"; code?: string; counts?: BundleManifest["counts"]; packId?: string;
  /** From the engine (read-only): how many live Personal lines of THIS computer the bundle's stamps match, the number an import blanks. Above `BLANK_CONFIRM_ABOVE` the import is refused unless `confirmBlank` is this exact number. */
  wouldBlank?: number;
  /** Lines of the bundle the engine's entry check would not take (secret shape, too long, a kind a Personal store does not take, not text), and the reasons. */
  rejected?: number;
  rejectedBy?: Record<string, number>;
  /** An upper estimate of the lines the receiving store has no room for (`store_full`): the number the confirmation window of an old record may show. Present only when the RECEIVING computer asked (`checkStaged` `receiving`) and the
   * engine answered a number (0 = everything fits); absent = not known. */
  wouldStoreFull?: number;
  /** Audit 62 (engine `f9643740`): what `import` would refuse BEFORE it writes (`home_state_denied`, `engines_not_confirmed`); only when the engine was told the engine roots. The receiver does not commit while it is `engines_not_confirmed`. */
  wouldRefuse?: string;
  /** Repair 5: on an `invalid` answer of `engine_too_large`, what the engine said about the size (`limitBytes`, `maxLimitBytes`, `bundleBytes`, `needs`). */
  tooLarge?: TooLargeFacts;
}
/** Mirrors the engine's `BLANK_LIMIT` (one_pack.py); the engine decides, this only lets a caller say "ask the owner" before calling. */
export const BLANK_CONFIRM_ABOVE = 20;

/** Is this staged folder a bundle that can be imported: every file as listed, every text file well formed, and the engine accepts the memory file. Reads only.
 *
 * `receiving`: this computer is the one that takes the bundle in, and the engine is called from THIS computer's engine home. Only then does `wouldStoreFull` mean anything (the engine counts the room in the store it is called from);
 * a check that the sender makes of its own bundle in its own engine home is a number about the wrong store, so without `receiving` the field is dropped. A missing field is "not known" and stays missing: it is never made 0
 * (desktop C item 1). */
export async function checkStaged(dir: string, options: { caller: OnePackCaller; /** the old-record road: the import will take no stamp (audit 59 B1) */ noStamps?: boolean; /** the caller is the receiving computer (see above) */ receiving?: boolean; /** O54: pass `--limit-bytes` (the engine lists `limit_100mib`) */ limitBytes?: number; /** audit 62: the engine roots `import` will be given (only for an engine that knows `ready`) */ engineRoots?: string[] }): Promise<CheckResult> {
  const parts = readParts(dir);
  if ("code" in parts) return { state: "invalid", code: parts.code };
  const checkExtras: Pick<CheckResult, "wouldBlank" | "rejected" | "rejectedBy" | "wouldStoreFull" | "wouldRefuse"> = {};
  if (parts.manifest.files["memory.sqlite"]) {
    const verdict = await options.caller(["check", "--bundle", path.join(dir, "memory.sqlite"), ...(options.noStamps ? ["--no-stamps"] : []), ...(options.limitBytes ? ["--limit-bytes", String(options.limitBytes)] : []), ...(options.engineRoots ?? []).flatMap((r) => ["--engine", r])], scaledMs(CHECK_TIMEOUT_MS, 1_000, options.limitBytes ?? 0));
    if (!verdict) return { state: "invalid", code: options.noStamps ? await noAnswerCode(options.caller, path.join(dir, "memory.sqlite")) : "engine_no_answer" };
    if (options.noStamps && !hasFeatures(verdict, NO_STAMPS_FEATURES)) return { state: "invalid", code: "engine_too_old" };
    if (verdict.state !== "ok") { const tl = readTooLarge(verdict); return { state: "invalid", code: `engine_${machineCode(verdict.reason ?? verdict.state, "invalid")}`, ...(Object.keys(tl).length ? { tooLarge: tl } : {}) }; }   // a reason this desktop has never seen is carried as the engine's own code
    if (typeof verdict.wouldBlank === "number") checkExtras.wouldBlank = verdict.wouldBlank;
    if (typeof verdict.wouldRefuse === "string" && CODE_RE.test(verdict.wouldRefuse)) checkExtras.wouldRefuse = verdict.wouldRefuse;
    const refused = refusedTotal(verdict);
    if (refused !== undefined) checkExtras.rejected = refused;
    const by = readRefusedBy(verdict.rejectedBy);
    if (by) checkExtras.rejectedBy = by;
    if (options.receiving === true && typeof verdict.wouldStoreFull === "number" && Number.isSafeInteger(verdict.wouldStoreFull) && verdict.wouldStoreFull >= 0) checkExtras.wouldStoreFull = verdict.wouldStoreFull;
  }
  return { state: "ok", counts: parts.manifest.counts, packId: parts.manifest.packId, ...checkExtras };
}

// --- import -----------------------------------------------------------------------------------------------------------------

export interface ImportResult {
  /** `imported` = everything that is applied here is done and the staging folder is gone. `partial` = memory is in but a part waits for the caller (`code`), staging kept: call again.
   * `remaining` = the store was busy or the engine gave no answer: nothing else was applied, staging kept: call again. `invalid` = unusable bundle, staging removed.
   * `refused` = nothing was written (the conversation, check-ins and seed are not applied either) and the staging folder is KEPT. Code `home_state_denied`: this computer's home mirror says `away` or `sealed`, or is not a known
   * value (`homeState` says which, `unknown` for the last); the caller calls again once the owner has moved the home here. Code `blank_over_limit`: the stamps would blank more of this computer's Personal lines than the
   * engine's limit (`wouldBlank`, `memory.limit`); the caller shows the owner the number and calls again with `confirmBlank` set to exactly it (a different number is refused again). */
  state: "imported" | "partial" | "remaining" | "invalid" | "refused";
  homeState?: string;
  /** Desktop repair 6: why the engine left what it left (`{views: "views_path_too_long" | "views_file_busy" | "views_retry"}`), when it said. `views_path_too_long` alone does not keep an import `partial` (nothing a later call changes). */
  leftReasons?: LeftReasons;
  /** Audit 62 (engine `f9643740`): on a refusal that is not a success, whether calling again can change the answer (`false`: only something OUTSIDE changing does) and what has to change (`needs`: `plugin_update`, `owner_bind`, `disk_space`, ...). */
  retryable?: boolean; needs?: string;
  /** Repair 5: an `invalid` / `engine_too_large` answer's size facts (see `TooLargeFacts`). */
  tooLarge?: TooLargeFacts;
  wouldBlank?: number;
  /** `engines_not_confirmed`: the engine's answer, host labels and numbers only (no path): which engine copies on this computer do not yet read a bundle stamp safely. */
  engines?: unknown;
  /** What the engine refused to take in: the count, and the ids (no text), at most 200; `rejectedIdsTruncated` when there were more. Give these to `purgePacked` on the sending computer as `keepIds` (and the flag as `rejectedIdsTruncated`). */
  rejected?: number;
  rejectedIds?: string[];
  rejectedIdsTruncated?: boolean;
  code?: string;
  packId?: string;
  memory?: EngineAnswer | null;
  conversation?: ConversationImport;
  checkinsAdded?: number;
  /** check-ins of the bundle that were not added because of the limits of the personal agent's own check-ins (F-4) */
  checkinsDropped?: number;
  /** What the engine's answers say it added (old-record road and move alike): the ids of the added lines (at most the engine's cap per answer, the ids of all answers of this call in one list), how many it said it added,
   * whether some are not named (`truncated`: the list was cut; `gap`: an attempt that added lines gave no list - no answer, `remaining`). The caller marks where the lines came from by this list, never by the shape of an id. */
  inserted?: { ids: string[]; count: number; truncated: boolean; gap: boolean };
  contextSeedPlanted?: boolean;
  /** Handed back, not applied: the profile table (which side wins, the server's closed values) is O-M3's. */
  profile?: Record<string, unknown> | null;
  avatar?: Buffer | null;
  settings?: Record<string, unknown> | null;
  reconnect?: ReconnectNames | null;
  droppedEmbeddings?: boolean;
  droppedMessages?: number;
  stagingRemoved?: boolean;
}

/** Merges a staged bundle into this computer: memory through the engine (the order is the engine's: stamps, blank, filter, insert), then the conversation, the check-ins and the context seed.
 * Every part is idempotent; a call that died anywhere is simply made again with the same staging folder. The staging folder is deleted when the import is finished or the bundle is unusable. */
export async function importStaged(dir: string, host: BundleHost, options: { caller: OnePackCaller; retryPauseMs?: number; confirmBlank?: number; /** O54: `--limit-bytes` for the engine's own size check (it lists `limit_100mib`) */ limitBytes?: number; /** more engine copies the engine should count (the bundled one) */ engineRoots?: string[];
  /** the old-record road: take no forget stamp and blank no line of this computer; the engine must say it knows the road */ noStamps?: boolean }): Promise<ImportResult> {
  const checked = await checkStaged(dir, options);
  if (checked.code === "engine_too_old") return { state: "remaining", code: "engine_too_old" };   // nothing was written and the staging folder stays: the engine is replaced, then the same call goes on
  if (checked.state !== "ok") return { state: "invalid", code: checked.code, ...(checked.tooLarge ? { tooLarge: checked.tooLarge } : {}), stagingRemoved: removeOwned(dir) };
  const parts = readParts(dir);
  if ("code" in parts) return { state: "invalid", code: parts.code, stagingRemoved: removeOwned(dir) };
  const packId = parts.manifest.packId;
  const pause = options.retryPauseMs ?? RETRY_PAUSE_MS;
  let memory: EngineAnswer | null = null;
  let insertedMarks: ImportResult["inserted"] | undefined;
  if (parts.manifest.files["memory.sqlite"]) {
    // Audit 61 N-2: the receiving store has its original-wording table before the engine imports a line (both roads: a move and an old record).
    if (host.ensureNativeTable) { try { host.ensureNativeTable(); } catch { return { state: "remaining", code: "native_table_failed", packId }; } }
    const confirm = !options.noStamps && Number.isSafeInteger(options.confirmBlank) && (options.confirmBlank as number) >= 0 ? ["--confirm-blank", String(options.confirmBlank)] : [];
    const roots = (options.engineRoots ?? []).filter((r) => typeof r === "string" && r.length > 0).flatMap((r) => ["--engine", r]);
    // Every answer of every attempt is looked at: a line that an attempt added and its answer did not name (no answer, `remaining`) is a line whose id is not known (`gap`); the ids of the attempts that did answer are one list.
    const trace: EngineAnswer[] = []; let silent = false;
    const traced: OnePackCaller = async (args, timeoutMs) => { const a = await options.caller(args, timeoutMs); if (a) trace.push(a); else silent = true; return a; };
    memory = await callUntilFinal(traced, ["import", "--bundle", path.join(dir, "memory.sqlite"), ...(options.noStamps ? ["--no-stamps"] : []), ...confirm, ...(options.limitBytes ? ["--limit-bytes", String(options.limitBytes)] : []), ...roots], scaledMs(IMPORT_TIMEOUT_MS, 5_000, options.limitBytes ?? 0), pause, ["imported", "partial", "refused"]);
    const ids = [...new Set(trace.flatMap((a) => (Array.isArray(a.insertedIds) ? (a.insertedIds as unknown[]).filter((x): x is string => typeof x === "string") : [])))];
    const unnamed = silent || trace.some((a) => a !== memory && !["busy", "refused", "invalid"].includes(a.state));
    const count = trace.reduce((n, a) => n + (Number.isSafeInteger(a.inserted) ? (a.inserted as number) : 0), 0);
    const marks: NonNullable<ImportResult["inserted"]> = { ids, count, gap: unnamed, truncated: trace.some((a) => a.insertedIdsTruncated === true) || ids.length < count };
    if (!memory) return { state: "remaining", code: "engine_no_answer", packId, inserted: marks };
    if (memory.state === "refused") {
      return { state: "refused", code: String(memory.reason ?? "home_state_denied"), homeState: typeof memory.homeState === "string" ? memory.homeState : undefined,
        ...(typeof memory.wouldBlank === "number" ? { wouldBlank: memory.wouldBlank } : {}), ...(memory.engines !== undefined ? { engines: memory.engines } : {}), ...(memory.retryable === false ? { retryable: false } : {}), ...(typeof memory.needs === "string" && CODE_RE.test(memory.needs) ? { needs: memory.needs } : {}), packId, memory };
    }
    if (memory.state === "invalid") { const tl = readTooLarge(memory); return { state: "invalid", code: `engine_${machineCode(memory.reason, "invalid")}`, ...(Object.keys(tl).length ? { tooLarge: tl } : {}), packId, stagingRemoved: removeOwned(dir) }; }
    if (memory.state !== "imported" && memory.state !== "partial") return { state: "remaining", code: `engine_${memory.state}${memory.reason ? "_" + String(memory.reason) : ""}`, packId, memory, inserted: { ...marks, gap: marks.gap || ["remaining", "failed", "deferred"].includes(memory.state) } };
    insertedMarks = marks;
  }
  const conversation = importConversation(host.db, host.oneId, parts.conversation, host.ensurePersonalChat, parts.noticesStripped, { badDate: parts.droppedBadDate, over: parts.droppedOver });
  let checkinsAdded = 0, checkinsDropped = 0;
  if (parts.checkins.length && host.checkins?.merge) {
    const merged = host.checkins.merge(parts.checkins);
    if (typeof merged === "number") checkinsAdded = merged; else { checkinsAdded = merged.added; checkinsDropped = merged.dropped; }
  }
  const planted = parts.seed.length && host.plantContextSeed ? host.plantContextSeed(packId, parts.seed) : false;
  const base: ImportResult = {
    state: "imported", packId, memory, conversation, checkinsAdded, ...(checkinsDropped ? { checkinsDropped } : {}), contextSeedPlanted: planted,
    profile: parts.profile, avatar: parts.avatar, settings: parts.settings, reconnect: parts.reconnect,
    ...((refusedTotal(memory) ?? 0) > 0 ? { rejected: refusedTotal(memory) as number } : {}),   // a reason this desktop does not know still counts (item 2); the sender keeps one line per refused id
    ...(Array.isArray(memory?.rejectedIds) ? { rejectedIds: (memory?.rejectedIds as unknown[]).filter((x): x is string => typeof x === "string") } : {}),
    ...(memory?.rejectedIdsTruncated === true ? { rejectedIdsTruncated: true } : {}),
    droppedEmbeddings: parts.manifest.droppedEmbeddings, droppedMessages: parts.manifest.droppedMessages,
    ...(insertedMarks ? { inserted: insertedMarks } : {}),
  };
  if (conversation.state === "no_personal_chat") return { ...base, state: "partial", code: "conversation_no_chat" };
  const memoryLeft = leftOfAnswer(memory);
  if (memoryLeft.reasons) base.leftReasons = memoryLeft.reasons;
  if (memory?.state === "partial" && !memoryLeft.endsHere) return { ...base, state: "partial", code: "memory_finish_left" };
  return { ...base, stagingRemoved: removeOwned(dir) };
}

// --- purge ------------------------------------------------------------------------------------------------------------------

export interface PurgeResult { state: "purged" | "remaining" | "failed" | "refused"; code?: string; /** Desktop repair 6: why the engine left what it left, when it said (see `ImportResult.leftReasons`). */ leftReasons?: LeftReasons; purged?: number; alreadyGone?: number; skippedTotal?: number; /** listed ids that were left on purpose (`keepIds`) */ kept?: number; skipped?: unknown; dirRemoved?: boolean }
const KEEP_IDS = "keep-ids.json";

/** Deletes the old Personal memory lines on THIS computer, by the id list the pack kept and nothing else (engine `one_pack purge`: no stamp, no other line). The caller calls this only after
 * the receiver has confirmed the import. Conversation lines are not deleted (the caller unbinds the conversation: "before the move", read-only; deleting lines would delete their photos).
 * When the purge is finished the pack folder is removed.
 *
 * `keepIds`: the ids the receiving computer refused (`ImportResult.rejectedIds`): those lines never arrived, so they are not deleted here (the answer's `kept` says how many were left). `rejectedIdsTruncated`
 * (from the same import answer): the receiver listed only some of the refused ids, so which listed lines arrived is not known: nothing is deleted, the answer is `refused` / `rejected_ids_incomplete` and the
 * pack folder stays. The ids are written to `keep-ids.json` inside the pack folder for the engine call; they carry no text and are never logged. */
export async function purgePacked(dir: string, options: { caller: OnePackCaller; retryPauseMs?: number; keepIds?: string[]; rejectedIdsTruncated?: boolean; /** Security follow-up S2: how many lines the receiver said it refused. When given, `keepIds` must hold exactly that many or nothing is deleted. */ expectedKept?: number }): Promise<PurgeResult> {
  if (!ownedDir(dir) || !fs.existsSync(path.join(dir, PURGE_IDS))) return { state: "failed", code: "not_a_pack_folder" };
  if (options.rejectedIdsTruncated === true) return { state: "refused", code: "rejected_ids_incomplete" };
  const args = ["purge", "--ids-file", path.join(dir, PURGE_IDS)];
  const keep = [...new Set((options.keepIds ?? []).filter((x): x is string => typeof x === "string"))];
  if (options.expectedKept !== undefined && keep.length !== options.expectedKept) return { state: "refused", code: "rejected_ids_incomplete" };   // the kept ids do not account for every refused line: nothing is deleted
  if (keep.length) { fs.writeFileSync(path.join(dir, KEEP_IDS), JSON.stringify(keep), { mode: 0o600 }); args.push("--keep-ids-file", path.join(dir, KEEP_IDS)); }
  const answer = await callUntilFinal(options.caller, args, PURGE_TIMEOUT_MS, options.retryPauseMs ?? RETRY_PAUSE_MS, ["purged", "partial"]);
  if (!answer) return { state: "remaining", code: "engine_no_answer" };
  const answerLeft = leftOfAnswer(answer);
  if (answer.state === "purged" || (answer.state === "partial" && answerLeft.endsHere)) {
    return { state: "purged", purged: Number(answer.purged ?? 0), alreadyGone: Number(answer.alreadyGone ?? 0), skippedTotal: Number(answer.skippedTotal ?? 0), kept: Number(answer.kept ?? 0), ...(answer.skipped ? { skipped: answer.skipped } : {}), ...(answerLeft.reasons ? { leftReasons: answerLeft.reasons } : {}), dirRemoved: removeOwned(dir) };
  }
  if (answer.state === "no_store") return { state: "purged", purged: 0, alreadyGone: 0, skippedTotal: 0, dirRemoved: removeOwned(dir) };
  return { state: answer.state === "failed" || answer.state === "deferred" ? "failed" : "remaining", code: `engine_${answer.state}${answer.reason ? "_" + String(answer.reason) : ""}` };
}

/** Deletes the Personal memory lines named by id on THIS computer through the engine's id purge (the same one the sender's purge uses: no forget stamp, no other line, a line that is not Personal is skipped) and nothing else.
 * The ids go through a file in a folder this module owns, removed in `finally`. For "forget everything from this computer": the caller chose the ids by their origin mark, never by words. */
export async function purgeIdList(ids: string[], options: { workDir: string; caller: OnePackCaller; retryPauseMs?: number }): Promise<PurgeResult> {
  if (!ids.length) return { state: "purged", purged: 0, alreadyGone: 0, skippedTotal: 0 };
  const dir = makeOwnedDir(options.workDir, "one-forget-");
  try {
    fs.writeFileSync(path.join(dir, PURGE_IDS), JSON.stringify(ids), { mode: 0o600 });
    const answer = await callUntilFinal(options.caller, ["purge", "--ids-file", path.join(dir, PURGE_IDS)], PURGE_TIMEOUT_MS, options.retryPauseMs ?? RETRY_PAUSE_MS, ["purged", "partial"]);
    if (!answer) return { state: "remaining", code: "engine_no_answer" };
    const answerLeft = leftOfAnswer(answer);
    if (answer.state === "purged" || (answer.state === "partial" && answerLeft.endsHere)) return { state: "purged", purged: Number(answer.purged ?? 0), alreadyGone: Number(answer.alreadyGone ?? 0), skippedTotal: Number(answer.skippedTotal ?? 0), ...(answerLeft.reasons ? { leftReasons: answerLeft.reasons } : {}) };
    if (answer.state === "no_store") return { state: "purged", purged: 0, alreadyGone: ids.length, skippedTotal: 0 };
    return { state: answer.state === "failed" || answer.state === "deferred" ? "failed" : "remaining", code: `engine_${answer.state}${answer.reason ? "_" + String(answer.reason) : ""}` };
  } finally { removeOwned(dir); }
}

// --- what stays behind ------------------------------------------------------------------------------------------------------

export interface LeftBehind {
  /** Codes the end screen turns into sentences; each is true on the old computer after the move. */
  stays: string[];
  counts: { conversationMessages: number; activeWork: number; olderVersions?: number; reconnect: { providers: number; appKeys: number; mcpServers: number } };
  leftOut: { embeddings: boolean; messages: number };
}

/** The facts for "what stays on this computer" (5.8.8): codes and counts only. Reads; changes nothing. */
export function describeLeftBehind(host: BundleHost, packed?: Pick<PackResult, "manifest">): LeftBehind {
  const chat = boundPersonalChat(host.db, host.oneId);
  const names = host.reconnect?.() ?? null;
  const stays = ["photos_and_files", "checkpoints", "team_sessions_and_rooms", "automations", "keychain_items", "my_rules_file", "work_knowledge", "turn_summaries_of_moved_memory", "conversation_before_the_move"];
  const activeWork = host.activeWorkCount?.() ?? 0;
  if (activeWork > 0) stays.unshift("running_delegated_work");
  // A purge deletes the live Personal lines by id. The older versions of a line the owner edited are not live lines: they stay on this computer, and the owner is told how many.
  let older = 0; try { older = Math.max(0, Math.floor(host.olderVersionCount?.() ?? 0)); } catch { older = 0; }
  if (older > 0) stays.push("older_versions_of_moved_memory");
  return {
    stays,
    counts: { conversationMessages: chat ? readConversation(host.db, chat).length : 0, activeWork, ...(older > 0 ? { olderVersions: older } : {}), reconnect: { providers: cleanNames(names?.providers).length, appKeys: cleanNames(names?.appKeys).length, mcpServers: cleanNames(names?.mcpServers).length } },
    leftOut: { embeddings: packed?.manifest?.droppedEmbeddings === true, messages: packed?.manifest?.droppedMessages ?? 0 },
  };
}
