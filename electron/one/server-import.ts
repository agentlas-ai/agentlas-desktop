/*
 * Putting the server's copy of the personal agent into this computer (Agentlas 2.0 O-M3b, contracts/one-home-move.md §4, one-home-desktop.md §6).
 * The ONE place that holds the server-profile table and the section-to-place table. Not a bundle: the four `move/export` sections arrive as pages.
 *
 * Files (the receiver's `stagingBase/<moveId>/export/`): `<section>.<n>.json` per page, `<section>.done` when the section ended. Who reads: this file (`readSection`, `applyServerExport`).
 * Who deletes: the move (`reported`, cancel, expiry, `no_such_move`, restart with another moveId) through `removeExportDir`, which re-reads the absence.
 *
 * Every function here is idempotent: a second run changes nothing (message ids `hope-server:<seq>`, one context seed per moveId, a fact id `hope-server-fact:<id>`).
 * Text from the server is untrusted input. It never reaches a prompt module, a tool result or a log line from this file.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { rmSyncWithRetry } from "../fs/retry";
import { createdAtOk, importConversation, type ConversationLine, type SeedTurn, CONTEXT_SEED_TURNS } from "./bundle";

export const EXPORT_SECTIONS = ["profile", "checkins", "facts", "messages"] as const;
export type ExportSection = typeof EXPORT_SECTIONS[number];
const PAGE_FILE = /^(profile|checkins|facts|messages)\.(\d{1,6})\.json$/;
const DONE_FILE = /^(profile|checkins|facts|messages)\.done$/;
const SEED_TEXT_MAX = 8_000;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ── files ──
/** Audit 59 B8: the folder of one move is `<stagingBase>/<moveId>` and nothing else. `moveId` is the server's id; one that is not the id shape (`../x`, an absolute path, an empty or a long text) never becomes a path: it throws (the caller treats a throw as "no such folder"). */
const MOVE_FOLDER = /^mv_[A-Za-z0-9_-]{24}$/;
export function moveFolderOf(stagingBase: string, moveId: string): string {
  const base = path.resolve(stagingBase); const own = path.resolve(base, String(moveId));
  if (!MOVE_FOLDER.test(String(moveId)) || path.dirname(own) !== base) throw new Error("move_id_invalid");
  return own;
}
export function exportDirOf(stagingBase: string, moveId: string): string { return path.join(moveFolderOf(stagingBase, moveId), "export"); }
export function writeExportPage(dir: string, section: ExportSection, n: number, items: unknown[]): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${section}.${n}.json`), JSON.stringify(items), { mode: 0o600 });
}
export function markSectionDone(dir: string, section: ExportSection): void { fs.writeFileSync(path.join(dir, `${section}.done`), "1", { mode: 0o600 }); }
export function sectionDone(dir: string, section: ExportSection): boolean { return fs.existsSync(path.join(dir, `${section}.done`)); }
/** A section that did not finish is started again from its first page (its half pages are removed first). */
export function resetSection(dir: string, section: ExportSection): void {
  try { for (const name of fs.readdirSync(dir)) { const m = PAGE_FILE.exec(name) ?? DONE_FILE.exec(name); if (m && m[1] === section) fs.rmSync(path.join(dir, name), { force: true }); } } catch { /* no folder yet */ }
}
export function readSection(dir: string, section: ExportSection): unknown[] {
  const pages: Array<{ n: number; name: string }> = [];
  for (const name of fs.readdirSync(dir)) { const m = PAGE_FILE.exec(name); if (m && m[1] === section) pages.push({ n: Number(m[2]), name }); }
  pages.sort((a, b) => a.n - b.n);
  const out: unknown[] = [];
  for (const p of pages) { const v = JSON.parse(fs.readFileSync(path.join(dir, p.name), "utf8")) as unknown; if (Array.isArray(v)) out.push(...v); }
  return out;
}
/** Removes the plaintext export folder of a move (and the move's own folder when empty) and re-reads: true only when nothing is left. */
export function removeExportDir(stagingBase: string, moveId: string): boolean {
  let own: string; try { own = moveFolderOf(stagingBase, moveId); } catch { return true; }   // an id that is not an id names no folder: nothing is removed
  try { rmSyncWithRetry(own); } catch { /* checked below */ }   // retries (fs/retry.ts): a Windows virus scanner or indexer may hold a file for a moment, and a process whose working folder is inside makes the folder busy
  return !fs.existsSync(own);
}

// ── profile table (one-home-desktop.md §6) ──
export const CHARACTERS: ReadonlySet<string> = new Set(["orange-dino", "blue-wave", "green-cloud", "purple-beacon", "amber-pod", "orange-sprout", "red-triangle"]);
export const STYLE_LINE: Record<string, { ko: string; en: string }> = {
  casual: { ko: "말투: 편하게 반말", en: "Way of talking: Casual" },
  polite: { ko: "말투: 공손하게", en: "Way of talking: Polite" },
  brief: { ko: "말투: 짧고 간결하게", en: "Way of talking: Short and simple" },
  warm: { ko: "말투: 따뜻하게", en: "Way of talking: Warm" },
};
export const DEFAULT_DISPLAY_NAME = "One";
export const DEFAULT_AVATAR_ICON = "character:orange-dino";

export interface LocalProfileView { displayName: string; avatarIcon: string; profileContext: string; preferredLocale: string; timeZone: string | null }
export interface ProfilePatch { displayName?: string; avatarIcon?: string; profileContext?: string; preferredLocale?: string; timeZone?: string; role?: string; bubbleColor?: string }
export interface ProfilePlan { patch: ProfilePatch; ask: { here: { displayName: string; avatarIcon: string }; incoming: { displayName?: string; avatarIcon?: string } } | null }

const cleanName = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim();
  return t && Array.from(t).length <= 64 ? t : null;
};
const timeZoneOk = (v: unknown): v is string => { if (typeof v !== "string" || !v || v.length > 128) return false; try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } };

/**
 * What the server's profile changes here. "Who wins" (design 5.8.6): a value the owner did not touch here (the default) takes the server's; both touched and different = ask once (the
 * answer is `here` or `incoming`; closing the question keeps this computer's). Values outside the closed tables (a future character, a damaged one) change nothing. `oneId` is never touched.
 */
export function planServerProfile(server: unknown, here: LocalProfileView): ProfilePlan {
  const patch: ProfilePatch = {};
  if (!isRecord(server)) return { patch, ask: null };
  const incoming: { displayName?: string; avatarIcon?: string } = {};
  const name = cleanName(server.name);
  if (name && name !== here.displayName) incoming.displayName = name;
  const icon = typeof server.character === "string" && CHARACTERS.has(server.character) ? `character:${server.character}` : null;
  if (icon && icon !== here.avatarIcon) incoming.avatarIcon = icon;
  let conflict = false;
  if (incoming.displayName !== undefined) { if (here.displayName === DEFAULT_DISPLAY_NAME) patch.displayName = incoming.displayName; else conflict = true; }
  if (incoming.avatarIcon !== undefined) { if (here.avatarIcon === DEFAULT_AVATAR_ICON) patch.avatarIcon = incoming.avatarIcon; else conflict = true; }
  const style = typeof server.style === "string" ? STYLE_LINE[server.style] : undefined;
  if (style && here.profileContext.trim() === "") patch.profileContext = server.language === "en" ? style.en : style.ko;
  if ((server.language === "ko" || server.language === "en") && here.preferredLocale === "system") patch.preferredLocale = server.language;
  if (timeZoneOk(server.timeZone) && !here.timeZone) patch.timeZone = server.timeZone;
  return { patch, ask: conflict ? { here: { displayName: here.displayName, avatarIcon: here.avatarIcon }, incoming } : null };
}

// ── messages ──
/** basis: the server's own longest word or bubble, in characters (code points): web `companion-chat.mjs` `maxTextChars` 4000 = contracts/one-home-mirror.md section 2. A word of a good server never reaches it; at the limit the word is not stored and is COUNTED (`dropped.tooLong`). */
export const SERVER_WORD_MAX_CHARS = 4_000;
/** basis: the server's clock is a third clock (the bundle road's 10 minutes is between two computers); a computer whose clock is a few hours behind (a dead battery, a wrong time zone: at most 14 hours apart) must still take its conversation. A date further ahead than this is a forged or broken one. At the limit: the word is not stored and is COUNTED (`dropped.badDate`). */
const SERVER_CLOCK_SKEW_MS = 24 * 3_600_000;
export interface DroppedWords { /** seq not a number, a role that is not user/friend, no `createdAt` */ badShape: number; /** `createdAt` that is not an ISO date or lies in the future (the bundle road's own check) */ badDate: number; tooLong: number }
export interface MessagesPlan { lines: ConversationLine[]; photoOnlySkipped: number; seed: SeedTurn[]; /** TH+MT F2: the turn each line was said in (the server names it on every item), so a turn the server forgets later takes its words from this computer too (server-turns.ts). */ turns: Array<{ id: string; turnId: string }>;
  /** Audit D4/D8: what was NOT stored because it is not a word (the caller counts it). A photo-only and a blank word are by design (`photoOnlySkipped`), not counted here. */ dropped: DroppedWords }
export function planServerMessages(items: unknown[]): MessagesPlan {
  const lines: ConversationLine[] = [];
  const turns: Array<{ id: string; turnId: string }> = [];
  const dropped: DroppedWords = { badShape: 0, badDate: 0, tooLong: 0 };
  const now = Date.now();
  let photoOnlySkipped = 0;
  for (const raw of items) {
    if (!isRecord(raw) || !Number.isSafeInteger(raw.seq) || (raw.seq as number) < 0) { dropped.badShape += 1; continue; }
    const role = raw.role === "friend" ? "assistant" : raw.role === "user" ? "user" : null;
    const text = typeof raw.text === "string" ? raw.text : "";
    const at = typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : null;
    if (!role || !at) { dropped.badShape += 1; continue; }
    if (!createdAtOk(at, now + SERVER_CLOCK_SKEW_MS)) { dropped.badDate += 1; continue; }   // the check the bundle road has had since F-12: a forged far-future date would stay at the end of the conversation for good
    if (!text.trim()) { if (raw.hasPhoto === true) photoOnlySkipped += 1; continue; }   // a photo-only turn is not moved: no photo, no empty line
    if (text.length > SERVER_WORD_MAX_CHARS * 2 || Array.from(text).length > SERVER_WORD_MAX_CHARS) { dropped.tooLong += 1; continue; }
    lines.push({ id: `hope-server:${raw.seq}`, role, text, createdAt: at });
    if (typeof raw.turnId === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(raw.turnId)) turns.push({ id: `hope-server:${raw.seq}`, turnId: raw.turnId });
  }
  const seed: SeedTurn[] = lines.slice(-CONTEXT_SEED_TURNS).map((l) => ({ role: l.role as "user" | "assistant", text: l.text.slice(0, SEED_TEXT_MAX), createdAt: l.createdAt }));
  return { lines, photoOnlySkipped, seed, turns, dropped };
}

/**
 * `oneHomeServiceWordId` of the phone (mobile `app/lib/core/one_home/one_home_forward.dart`), the same pure function with the same checks and the same order: a `friend-<id>` command id (a word that came FROM the service and was kept on a computer,
 * `companion_turn_controller.dart` `keptWordCommandId`) goes back under its own original `<id>` when that is an id (`^[A-Za-z0-9_-]{1,64}$`); else `moved-<commandId>` when that is an id; else `moved-` + the first 40 hex of the sha-256 of the command id.
 */
export function phoneWordId(commandId: string): string | null {
  if (typeof commandId !== "string" || !commandId) return null;
  if (commandId.startsWith("friend-")) { const original = commandId.slice(7); if (/^[A-Za-z0-9_-]{1,64}$/.test(original)) return original; }
  const direct = `moved-${commandId}`;
  if (/^[A-Za-z0-9_-]{1,64}$/.test(direct)) return direct;
  return `moved-${createHash("sha256").update(commandId, "utf8").digest("hex").slice(0, 40)}`;
}
/**
 * Audit D3 - the ONE place that merges the phone's word into this computer's own line, for BOTH roads that bring the server's words (the mirror's take and the move's import). A person's word that came here from the phone AND was put on the server
 * by the phone is one word: the server's item names the phone's id (`clientMessageId`); when this computer holds that word under the same id (its request's `command_id`, `phoneWordId`) the server's line is NOT added - the computer's own line is the one line.
 * An item without the id, or with an id nothing here carries, is kept. Bounded lookup: the ids of one page, 400 at a time.
 */
export function dropOwnWords(db: Database.Database, items: unknown[]): { kept: unknown[]; merged: number } {
  const wanted = new Set<string>();
  for (const it of items) if (isRecord(it) && it.role === "user" && typeof it.clientMessageId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(it.clientMessageId)) wanted.add(it.clientMessageId);
  if (!wanted.size) return { kept: items, merged: 0 };
  const own = new Set<string>();
  try {
    // a `moved-<id>` names the command id `<id>`; any other id may be the original of a kept `friend-<id>` word (the phone's function above); the hashed form cannot be inverted
    const direct = [...new Set([...wanted].flatMap((n) => [...(n.startsWith("moved-") && n.length > 6 ? [n.slice(6)] : []), `friend-${n}`]))];
    for (let i = 0; i < direct.length; i += 400) {
      const part = direct.slice(i, i + 400);
      for (const r of db.prepare(`SELECT command_id FROM one_supervisor_requests WHERE kind='reply' AND user_message_id IS NOT NULL AND command_id IN (${part.map(() => "?").join(",")})`).all(...part) as Array<{ command_id: string }>) { const id = phoneWordId(r.command_id); if (id) own.add(id); }
    }
  } catch { /* no requests table on a store that never had the personal agent: nothing is merged */ }
  if (!own.size) return { kept: items, merged: 0 };
  const kept = items.filter((it) => !(isRecord(it) && it.role === "user" && typeof it.clientMessageId === "string" && own.has(it.clientMessageId)));
  return { kept, merged: items.length - kept.length };
}

// ── facts ──
export interface FactWrite { id: string; kind: "preference" | "fact"; content: string; boundary?: unknown; sourceKind: string;
  /** TH+MT: the server's card as the mirror's take reads it (the same grades, the English line, the id the line is found by later): the move's import writes a card the way the mirror does, so a card is one line whichever road brought it. */ raw?: unknown }
export type FactOutcome = "written" | "already" | "rejected";
export function planServerFacts(items: unknown[]): { writes: FactWrite[]; skipped: number } {
  const writes: FactWrite[] = [];
  let skipped = 0;
  for (const raw of items) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(raw.id) || typeof raw.text !== "string" || !raw.text.trim() || raw.text.length > 4_000) { skipped += 1; continue; }
    const kind = raw.kind === "fact" ? "fact" : raw.kind === "identity" || raw.kind === "preference" || raw.kind === "boundary" ? "preference" : null;
    if (!kind) { skipped += 1; continue; }
    writes.push({ id: `hope-server-fact:${raw.id}`, kind, content: raw.text.trim(), ...(raw.kind === "boundary" && raw.boundary !== undefined ? { boundary: raw.boundary } : {}), sourceKind: String(raw.kind), raw });
  }
  return { writes, skipped };
}

// ── apply ──
export interface ServerImportPorts {
  db: Database.Database;
  oneId: string;
  ensurePersonalChat?(): string | null;
  plantContextSeed?(packId: string, turns: SeedTurn[]): boolean;
  /** Personal write path (admission checks are the path's own: secret shape, instruction shape, ceiling). */
  writeFact(fact: FactWrite): FactOutcome;
  localProfile(): LocalProfileView;
  applyProfile(patch: ProfilePatch): void;
  /** TH+MT F2: link the words just taken to the turns they were said in (server-turns.ts). Absent = not linked (a gate without it). */
  noteTurns?(pairs: Array<{ id: string; turnId: string }>): void;   // a throw is NOT swallowed (D2)
}
export interface ServerImportResult {
  state: "imported" | "partial";
  code?: string;
  messages: { inserted: number; alreadyThere: number; elsewhere: number; photoOnlySkipped: number; droppedSystem: number; /** the phone's words merged into this computer's own lines (D3) */ merged: number; /** words that are not words (D4/D8) */ dropped: number };
  seedPlanted: boolean;
  checkins: { droppedScheduled: number };
  profile: { applied: string[]; ask: ProfilePlan["ask"] };
  facts: { written: number; already: number; rejected: number; skipped: number };
}

/** The order of §4: conversation, check-ins, context seed, profile, fact cards. Reading failures stop before any write. */
export function applyServerExport(dir: string, moveId: string, ports: ServerImportPorts): ServerImportResult {
  const { kept: keptWords, merged: mergedWords } = dropOwnWords(ports.db, readSection(dir, "messages"));   // audit D3: the same merge as the mirror's take
  const msgs = planServerMessages(keptWords);
  const facts = planServerFacts(readSection(dir, "facts"));
  const checkins = readSection(dir, "checkins");
  const profileItem = readSection(dir, "profile")[0];
  // audit D2: the words and their links are ONE transaction (a word is never stored without its turn). When the link cannot be made the words go in without it and the result says `words_not_linked`: the move waits and runs this step again (idempotent; the words already there are linked then).
  let linked = true;
  const link = msgs.turns.length && ports.noteTurns ? () => ports.noteTurns!(msgs.turns) : undefined;
  let convo;
  try { convo = importConversation(ports.db, ports.oneId, msgs.lines, ports.ensurePersonalChat, 0, {}, link); }
  catch (error) { if (!link) throw error; linked = false; convo = importConversation(ports.db, ports.oneId, msgs.lines, ports.ensurePersonalChat); }
  const result: ServerImportResult = {
    state: "imported",
    messages: { inserted: convo.inserted, alreadyThere: convo.alreadyThere, elsewhere: convo.elsewhere, photoOnlySkipped: msgs.photoOnlySkipped, droppedSystem: convo.droppedSystem, merged: mergedWords, dropped: msgs.dropped.badShape + msgs.dropped.badDate + msgs.dropped.tooLong },
    seedPlanted: false, checkins: { droppedScheduled: checkins.length }, profile: { applied: [], ask: null }, facts: { written: 0, already: 0, rejected: 0, skipped: facts.skipped },
  };
  if (convo.state === "no_personal_chat") return { ...result, state: "partial", code: "conversation_no_chat" };
  if (!linked) return { ...result, state: "partial", code: "words_not_linked" };
  // A scheduled check-in of the server is dropped and counted: the computer's check-ins are its own and a time that has passed is not carried.
  if (msgs.seed.length && ports.plantContextSeed) result.seedPlanted = ports.plantContextSeed(moveId, msgs.seed);
  const plan = planServerProfile(profileItem, ports.localProfile());
  if (Object.keys(plan.patch).length) { ports.applyProfile(plan.patch); result.profile.applied = Object.keys(plan.patch); }
  result.profile.ask = plan.ask;
  for (const w of facts.writes) { const out = ports.writeFact(w); if (out === "written") result.facts.written += 1; else if (out === "already") result.facts.already += 1; else result.facts.rejected += 1; }
  return result;
}
