// Session scope: which journal, and so which native session, a conversation's turns belong to.
//
// Until this module every conversation owned its own journal (`chat:<chat id>`), so a new conversation with the same
// agent in the same seat opened a new native session and the agent forgot what its newest session had read. Here a
// one-to-one seat conversation takes its journal from the seat and the agent instead: the first turn after an update
// adopts the newest earlier journal of that agent in that seat BY ITS OLD DOMAIN STRING, so the context key, the
// fingerprint seed and the runner owner string stay exactly what that journal's own conversation used (an adopted
// session resumes under the very handle it had). Nothing is moved or deleted; the other journals stay where they are.
//
// A roster member (an agent seated on the One org chart, not archived) is one agent in two places: it works in the team
// dispatches of a group room (child conversations, one per dispatch or reused, each with a journal of its own until now) and
// the owner talks to it one-to-one. Those are ONE session: a dispatch child of a group room whose agent is a roster member
// takes the same journal as the member's one-to-one seat conversations (scope `seat:<the member's solo seat>`), across every
// room the member works in. The first assignment adopts the newest earlier journal of the member among its one-to-one
// conversations AND its dispatch children (the one with a native session handle first, then the most recently written), by its
// old domain string; the rest stay as they are. The message lists stay per conversation; each turn is told where it is spoken
// (the channel, session-channel.ts). The roster switch below can split the rooms from each other.
//
// This file must not import Electron: the background service loads the same code as the window process, and both
// must reach the same answer from the same database (the first assignment is written with INSERT OR IGNORE and
// re-read, so whichever process writes first wins).
//
// Safety switches (meta keys). `session-scope.mode`: `chat` returns the old formula for every conversation; `seat` and
// `full` scope the one-to-one seat conversations and the roster (`full` is reserved for later stages and means `seat` today). A
// missing value is `seat`; any other value is read as `chat`. `session-scope.roster` (only read when the mode is not `chat`):
// `shared` (the default) = one session per seat and member across rooms and the one-to-one conversations; `room` = one session
// per seat, member AND room (a room's dispatch children share their room's session; the one-to-one conversations keep theirs, so
// rooms do not share anything with each other or with the owner's one-to-one talk); `off` (and any other value) = a dispatch child
// keeps its own journal as before and the one-to-one conversations of a member look at their own journals only. A failure while
// resolving returns the old formula for a conversation outside the scoped kinds (it never reads the seat's records). For a seat
// conversation or a roster dispatch child it does NOT: the old formula would open a journal and a native session of its own for that
// turn, the turn would be missing from the shared session, and a conversation that already took a turn in the shared journal would
// never bring it in afterwards. The answer then says `unavailable` and the caller refuses the turn in plain words (a failure here is a
// busy or unreadable store, which the next try usually clears; `session-scope.mode` = `chat` is the way out when it does not). An
// assignment record that cannot be read is not a failure: it is rewritten (see resolveAssignment).
import type Database from "better-sqlite3";
import { BUILTIN_ONE_AGENT_ID } from "../../shared/builtin-agent-ids";

export type SessionScopeMode = "chat" | "seat" | "full";
export const SESSION_SCOPE_MODE_KEY = "session-scope.mode";
export const DEFAULT_SESSION_SCOPE_MODE: SessionScopeMode = "seat";
const ACTOR_KEY_PREFIX = "session-scope.actor:";
/** The assignment record keeps the other candidates for diagnostics only; a seat never has this many journals of one agent. */
const MAX_RETAINED = 256;

export interface SessionScopeInput {
  chatId: string;
  agentId: string;
  /** The conversation's kind and parent as the caller read them: the old formula is computed from these, whatever fails here. */
  kind: string | null;
  parentChatId: string | null;
  /** The alive controller's own domain; never scoped. */
  aliveController: boolean;
  /** The account/install part of the journal identity: assignments are made per owner scope. */
  ownerScope: string;
  /** The conversation's row as the caller already read it: with it a failure while resolving still knows whether the conversation is a seat conversation. */
  chat?: { agentId: string | null; kind: string | null; origin: string | null; seatId: string | null; seatKind: string | null };
  /**
   * true: the first assignment is stored (turn admission). false: the same answer is computed without writing
   * (recall of memory for a turn that has not been admitted yet) — until a record exists it names the domain the
   * admission will store, unless another process stored a different one in between.
   */
  persist: boolean;
}

/** legacy: the conversation's own journal; seat: a one-to-one seat conversation; roster: a roster member's dispatch child in a group room. */
export type SessionScopeKind = "legacy" | "seat" | "roster";
/**
 * Where a conversation's turns are spoken: with the owner alone (`direct`), in a group room (`room`: the room's own
 * conversation), as a child task dispatched from another conversation (`dispatch`: a room's teammate, or a Work stage), or
 * somewhere that has no human audience (`other`: the alive controller, an unknown kind). A label of the conversation, read from
 * its row: it changes neither the journal's domain nor who shares it.
 */
export type SessionChannelKind = "direct" | "room" | "dispatch" | "other";
export interface SessionChannel {
  kind: SessionChannelKind;
  /** The group room this conversation is (`room`) or was dispatched from (`dispatch` whose parent is a room); else null. */
  roomChatId: string | null;
  /** The room's title as the owner sees it (one line, bounded); null when there is none or this is not a room channel. */
  roomTitle: string | null;
}
export interface SessionScopeAssignment {
  /** adopted: an earlier journal of this agent in this seat continues; fresh: none existed; existing: stored before; healed: the stored record was unreadable and was rewritten. */
  outcome: "adopted" | "fresh" | "existing" | "healed";
  /** `chat:<id>` the assignment adopted, if it did. */
  fromDomain: string | null;
  /** Other journals of this agent in this seat that stay as they are. */
  retainedDomains: readonly string[];
  /** This call stored the record (the caller reports it once). */
  created: boolean;
}
export interface ResolvedSessionScope {
  kind: SessionScopeKind;
  mode: SessionScopeMode;
  visibilityDomain: string;
  /** Several conversations of one seat and agent use this journal: their turns run one after the other. */
  shared: boolean;
  scopeId: string | null;
  actorKey: string | null;
  /** The seat columns of the conversation this answer depends on; a later change of them is a changed scope. Null for a roster dispatch child: it keeps the group seat of its room, the member's own seat is not one of its columns. */
  seat: { seatId: string; seatKind: string } | null;
  assignment: SessionScopeAssignment | null;
  /** The old formula was returned because resolving failed (never because of the switch). */
  fallback: "error" | null;
  /** Resolving failed for a seat conversation: the old formula must not be used for its turn; the caller refuses it. */
  unavailable: boolean;
  /** The machine cause of that failure (a SQLite code, or this module's own). */
  failure: { causeCode: string } | null;
  /** Where this conversation speaks (a label; see SessionChannel). Shared sessions tell the agent; every other conversation is unchanged. */
  channel: SessionChannel;
}

/**
 * The domain every conversation had before scopes existed, byte for byte. The two places that derived it
 * (agent-context-admission.ts and memory/context-generation.ts) now call this through the resolver.
 */
export function legacyVisibilityDomain(row: { chatId: string; kind: string | null; parentChatId: string | null }, aliveController: boolean): string {
  return aliveController ? `alive-controller:${row.chatId}`
    : row.kind === "division" && row.parentChatId ? `one-team:${row.parentChatId}:session:${row.chatId}` : `chat:${row.chatId}`;
}

type ChatRow = { agent_id: string | null; kind: string | null; parent_chat_id: string | null; origin_surface: string | null; seat_id: string | null; seat_kind: string | null };

export function sessionScopeMode(db: Pick<Database.Database, "prepare">): SessionScopeMode {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(SESSION_SCOPE_MODE_KEY) as { value: string } | undefined;
  if (!row) return DEFAULT_SESSION_SCOPE_MODE;
  const value = String(row.value).trim().toLowerCase();
  return value === "seat" || value === "full" ? value : "chat";
}

export type RosterScopeMode = "shared" | "room" | "off";
export const ROSTER_SCOPE_KEY = "session-scope.roster";
export const DEFAULT_ROSTER_SCOPE_MODE: RosterScopeMode = "shared";
/** How roster members' dispatch children are scoped (see the header). A missing value is the default; any other value than `shared`/`room` is `off`. */
export function rosterScopeMode(db: Pick<Database.Database, "prepare">): RosterScopeMode {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(ROSTER_SCOPE_KEY) as { value: string } | undefined;
  if (!row) return DEFAULT_ROSTER_SCOPE_MODE;
  const value = String(row.value).trim().toLowerCase();
  return value === "shared" || value === "room" ? value : "off";
}

/** The conversations whose one-to-one journals a seat's agent may continue: user conversations of that solo seat. */
const SEAT_CHAT_PREDICATE = "c.seat_id=? AND c.seat_kind='solo' AND c.kind='user' AND c.origin_surface='one'";

const MAX_ROOM_TITLE_CHARS = 80;
const otherChannel = (): SessionChannel => ({ kind: "other", roomChatId: null, roomTitle: null });
/** A conversation title as one bounded line: it is owner-written text that ends up in a prompt line, so no control characters or line breaks. */
function oneLineTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? Array.from(text).slice(0, MAX_ROOM_TITLE_CHARS).join("") : null;
}
type ChannelRow = { kind: string | null; parent_chat_id: string | null; origin_surface: string | null; seat_kind: string | null; title: string | null };
const isGroupRoom = (row: ChannelRow): boolean => row.origin_surface === "one" && row.seat_kind === "group" && !row.parent_chat_id && (row.kind === "user" || row.kind === null);

/**
 * Where the turns of one conversation are spoken, read from its row (never from a title, a message or a model): a group room
 * (One surface, group seat, no parent) is `room`; a child with a parent is `dispatch` (naming the room when the parent is one);
 * any other user conversation is `direct`; the alive controller and anything unrecognised are `other`. A label only: it is
 * computed beside the journal's domain and changes neither it nor any adoption. A failure answers `other`, which tells no
 * agent anything.
 */
export function deriveSessionChannel(db: Pick<Database.Database, "prepare">, chatId: string, aliveController: boolean): SessionChannel {
  if (aliveController) return otherChannel();
  try {
    const read = (id: string): ChannelRow | undefined => db.prepare("SELECT kind,parent_chat_id,origin_surface,seat_kind,title FROM chats WHERE id=?").get(id) as ChannelRow | undefined;
    const row = read(chatId);
    if (!row) return otherChannel();
    if (row.kind === "division" && row.parent_chat_id) {
      const parent = read(row.parent_chat_id);
      return parent && isGroupRoom(parent) ? { kind: "dispatch", roomChatId: row.parent_chat_id, roomTitle: oneLineTitle(parent.title) }
        : { kind: "dispatch", roomChatId: null, roomTitle: null };
    }
    if (isGroupRoom(row)) return { kind: "room", roomChatId: chatId, roomTitle: oneLineTitle(row.title) };
    if (row.kind === "user" || row.kind === null) return { kind: "direct", roomChatId: null, roomTitle: null };
    return otherChannel();
  } catch { return otherChannel(); }
}

export const sessionScopeActorMetaKey = (ownerScope: string, scopeId: string, actorKey: string): string =>
  `${ACTOR_KEY_PREFIX}${ownerScope.slice(0, 16)}|${scopeId}|${actorKey}`;

interface StoredAssignment { v: 1; domain: string; adoptedFrom: string | null; retained: string[]; at: string }
const validDomain = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 512;
function parseAssignment(raw: string | undefined | null): StoredAssignment | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredAssignment>;
    if (value?.v !== 1 || !validDomain(value.domain)) return null;
    return { v: 1, domain: value.domain, adoptedFrom: typeof value.adoptedFrom === "string" ? value.adoptedFrom : null,
      retained: Array.isArray(value.retained) ? value.retained.filter((item): item is string => typeof item === "string") : [],
      at: typeof value.at === "string" ? value.at : "" };
  } catch { return null; }
}
/**
 * What an unreadable record still says. `newer`: a record of a later format (readable by a later build) that this build must
 * not overwrite; its domain is used as it is.
 */
function salvageAssignment(raw: string): { domain: string | null; adoptedFrom: string | null; retained: string[]; newer: boolean } {
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { domain: validDomain(value.domain) ? value.domain : null, adoptedFrom: typeof value.adoptedFrom === "string" ? value.adoptedFrom : null,
        retained: Array.isArray(value.retained) ? value.retained.filter((item): item is string => typeof item === "string") : [],
        newer: typeof value.v === "number" && value.v > 1 };
    }
  } catch { /* not JSON at all */ }
  return { domain: null, adoptedFrom: null, retained: [], newer: false };
}
const assignmentOf = (stored: StoredAssignment, created: boolean, healed = false): SessionScopeAssignment => ({
  outcome: healed && created ? "healed" : created ? (stored.adoptedFrom ? "adopted" : "fresh") : "existing",
  fromDomain: stored.adoptedFrom, retainedDomains: stored.retained, created });

/**
 * The journal an agent's one-to-one conversations in a seat continue: among the owner's journals of this agent whose
 * domain is `chat:<conversation of this seat>`, the one that holds a native session handle comes first, then the most
 * recently written one. The rest are retained as they are.
 */
function chooseSeatCandidates(db: Pick<Database.Database, "prepare">, ownerScope: string, seatId: string, agentId: string): string[] {
  // The seat's own domain `seat:<id>` is a candidate too: it is the journal an earlier assignment of this seat created when no
  // older one existed, so a seat whose record is lost or unreadable finds the journal its conversations were using.
  const rows = db.prepare(`SELECT json_extract(h.identity_json,'$.visibilityDomain') AS domain, MAX(h.updated_at) AS updated_at,
      MAX(EXISTS(SELECT 1 FROM agent_context_bindings b WHERE b.context_key=h.context_key AND b.native_handle IS NOT NULL AND b.native_handle<>'')) AS has_handle
    FROM agent_context_heads h
    WHERE json_extract(h.identity_json,'$.ownerScope')=? AND json_extract(h.identity_json,'$.agentId')=?
      AND (json_extract(h.identity_json,'$.visibilityDomain') IN (SELECT 'chat:'||c.id FROM chats c WHERE ${SEAT_CHAT_PREDICATE})
        OR json_extract(h.identity_json,'$.visibilityDomain')=?)
    GROUP BY domain ORDER BY has_handle DESC, updated_at DESC, domain ASC`).all(ownerScope, agentId, seatId, `seat:${seatId}`) as Array<{ domain: string }>;
  return rows.map(row => row.domain).filter(domain => typeof domain === "string" && domain.length > 0);
}

/** The dispatch children of group rooms a roster member worked in: child (division, One surface) of a parent that is a group room. */
const ROOM_CHILD_PREDICATE = `c.kind='division' AND c.origin_surface='one' AND c.agent_id=? AND p.origin_surface='one' AND p.seat_kind='group'
  AND p.parent_chat_id IS NULL AND (p.kind='user' OR p.kind IS NULL)`;
const ROOM_CHILD_DOMAINS = `SELECT 'one-team:'||c.parent_chat_id||':session:'||c.id FROM chats c JOIN chats p ON p.id=c.parent_chat_id WHERE ${ROOM_CHILD_PREDICATE}`;

/**
 * The journal a roster member's session continues, among the owner's journals of the member: for the shared scope its
 * one-to-one seat conversations' (`chat:<c>`), its dispatch children's (`one-team:<room>:session:<child>`, any room) and the
 * seat's own (`seat:<id>`); for a room's scope only that room's dispatch children's. The journal with a native session handle
 * comes first, then the most recently written one (the member's running session is the newest). The rest are retained.
 */
function chooseRosterCandidates(db: Pick<Database.Database, "prepare">, ownerScope: string, agentId: string,
  spec: { shared: { seatId: string } } | { room: { roomChatId: string } }): string[] {
  const where: string[] = [], args: unknown[] = [ownerScope, agentId];
  if ("shared" in spec) {
    where.push(`json_extract(h.identity_json,'$.visibilityDomain') IN (SELECT 'chat:'||c.id FROM chats c WHERE ${SEAT_CHAT_PREDICATE})`, `json_extract(h.identity_json,'$.visibilityDomain')=?`,
      `json_extract(h.identity_json,'$.visibilityDomain') IN (${ROOM_CHILD_DOMAINS})`);
    args.push(spec.shared.seatId, `seat:${spec.shared.seatId}`, agentId);
  } else {
    where.push(`json_extract(h.identity_json,'$.visibilityDomain') IN (${ROOM_CHILD_DOMAINS} AND c.parent_chat_id=?)`);
    args.push(agentId, spec.room.roomChatId);
  }
  const rows = db.prepare(`SELECT json_extract(h.identity_json,'$.visibilityDomain') AS domain, MAX(h.updated_at) AS updated_at,
      MAX(EXISTS(SELECT 1 FROM agent_context_bindings b WHERE b.context_key=h.context_key AND b.native_handle IS NOT NULL AND b.native_handle<>'')) AS has_handle
    FROM agent_context_heads h
    WHERE json_extract(h.identity_json,'$.ownerScope')=? AND json_extract(h.identity_json,'$.agentId')=? AND (${where.join(" OR ")})
    GROUP BY domain ORDER BY has_handle DESC, updated_at DESC, domain ASC`).all(...args) as Array<{ domain: string }>;
  return rows.map(row => row.domain).filter(domain => typeof domain === "string" && domain.length > 0);
}

/** An agent seated on the One org chart and not archived: the meaning of "roster member" for every rule here. */
export function isRosterMember(db: Pick<Database.Database, "prepare">, agentId: string): boolean {
  return !!db.prepare("SELECT 1 FROM one_org_members WHERE installed_agent_id=? AND archived_at IS NULL LIMIT 1").get(agentId);
}
/**
 * The solo seat a roster member's one-to-one conversations sit in: the newest open occupancy of a solo seat that belongs to no
 * Work project (the seat store's own choice for a new conversation, store/seats.ts ensureSoloSeatForAgent), else the seat id
 * that function would create first. The member's real seat ids are not all `seat_<agent id>` (a seat made with another id keeps it).
 */
export function rosterMemberSoloSeatId(db: Pick<Database.Database, "prepare">, agentId: string, ownerScope?: string): string {
  const open = db.prepare(`SELECT o.seat_id AS seat_id FROM one_seat_occupants o JOIN one_seats s ON s.id=o.seat_id
    WHERE o.agent_id=? AND o.until IS NULL AND s.kind='solo' AND s.dissolved_at IS NULL AND s.project_id IS NULL
    ORDER BY o.since DESC, o.seat_id ASC`).all(agentId) as Array<{ seat_id: string }>;
  // A seat that already holds this member's session keeps it: seating the member somewhere newer (a Telegram room's solo seat, a
  // second seat) must not move its dispatch children to a journal of their own while its one-to-one talk stays on the old one. Among
  // several such seats the oldest occupancy wins, so a newer seat never takes the children over.
  if (ownerScope && open.length > 1) {
    const has = db.prepare("SELECT 1 FROM meta WHERE key=?");
    for (const seat of [...open].reverse()) if (has.get(sessionScopeActorMetaKey(ownerScope, `seat:${seat.seat_id}`, `agent:${agentId}`))) return seat.seat_id;
  }
  return open[0]?.seat_id || `seat_${agentId}`;
}

interface AssignmentSpec {
  kind: SessionScopeKind; scopeId: string; actorKey: string; seat: { seatId: string; seatKind: string } | null;
  candidates: () => string[];
}
/**
 * The one stored decision of a (scope, actor): read it; when there is none, choose it (adopt the best candidate by its old domain
 * string, else the scope's own), and store it once whichever process gets here first. Used by the one-to-one seat conversations
 * and by a roster member's dispatch children, which are the same actor in the same scope.
 */
function resolveAssignment(db: Database.Database, input: SessionScopeInput, mode: SessionScopeMode, spec: AssignmentSpec, channel: SessionChannel): ResolvedSessionScope {
  const { scopeId, actorKey } = spec, key = sessionScopeActorMetaKey(input.ownerScope, scopeId, actorKey);
  const base = { kind: spec.kind, mode, shared: true, scopeId, actorKey, seat: spec.seat, fallback: null, unavailable: false, failure: null, channel };
  const read = (): string | undefined => (db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
  const raw = read();
  const stored = parseAssignment(raw);
  if (stored) return { ...base, visibilityDomain: stored.domain, assignment: assignmentOf(stored, false) };
  // A value that is there but cannot be read is not "no record": reading the seat's journal from scratch could pick another
  // journal than the one its conversations were using. What the damaged record still says (its domain, the journals it retained)
  // is kept; only what is missing is resolved again.
  const damaged = raw !== undefined;
  const salvage = damaged ? salvageAssignment(raw!) : null;
  const candidates = spec.candidates();
  const domain = salvage?.domain ?? candidates[0] ?? scopeId;
  const adoptedFrom = salvage?.domain ? salvage.adoptedFrom : candidates.length ? candidates[0] : null;
  const retained = [...new Set([...(salvage?.retained ?? []), ...candidates].filter(item => item !== domain))].slice(0, MAX_RETAINED);
  const chosen: StoredAssignment = { v: 1, domain, adoptedFrom, retained, at: new Date().toISOString() };
  // A record of a later format is read, never overwritten.
  if (!input.persist || salvage?.newer) return { ...base, visibilityDomain: chosen.domain, assignment: assignmentOf(chosen, false) };
  if (damaged) {
    // Rewrite it, once, whichever process gets here first: the replace only applies to the very value that was read.
    const rewritten = db.prepare("UPDATE meta SET value=? WHERE key=? AND value=?").run(JSON.stringify(chosen), key, raw).changes === 1;
    const winner = parseAssignment(read());
    if (!winner) throw new Error("session_scope_assignment_unreadable");
    return { ...base, visibilityDomain: winner.domain, assignment: assignmentOf(winner, rewritten, true) };
  }
  // First writer wins: the window process and the background service may both be here with the same first turn.
  const inserted = db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)").run(key, JSON.stringify(chosen)).changes === 1;
  const winner = parseAssignment(read());
  if (!winner) throw new Error("session_scope_assignment_unreadable");
  return { ...base, visibilityDomain: winner.domain, assignment: assignmentOf(winner, inserted) };
}

function resolveSeat(db: Database.Database, input: SessionScopeInput, mode: SessionScopeMode, seatId: string, channel: SessionChannel): ResolvedSessionScope {
  // A roster member's one-to-one conversations also look at the member's dispatch children (the same session); every other agent's
  // look at their own conversations only, exactly as before.
  const roster = rosterScopeMode(db) === "shared" && isRosterMember(db, input.agentId);
  return resolveAssignment(db, input, mode, { kind: "seat", scopeId: `seat:${seatId}`, actorKey: `agent:${input.agentId}`, seat: { seatId, seatKind: "solo" },
    candidates: () => roster ? chooseRosterCandidates(db, input.ownerScope, input.agentId, { shared: { seatId } }) : chooseSeatCandidates(db, input.ownerScope, seatId, input.agentId) }, channel);
}

/**
 * A dispatch child of a group room whose agent is a roster member: the member's team work. Its journal is the member's seat
 * scope (shared with its one-to-one conversations and, in the shared mode, with its work in every other room), or in the room mode
 * the member's scope in this room. null for every other conversation.
 */
function resolveRosterChild(db: Database.Database, input: SessionScopeInput, mode: SessionScopeMode, row: ChatRow, channel: SessionChannel): ResolvedSessionScope | null {
  const rosterMode = rosterScopeMode(db);
  if (rosterMode === "off") return null;
  if (!rosterShape({ agentId: row.agent_id, kind: row.kind, origin: row.origin_surface }, input)) return null;
  const parent = db.prepare("SELECT kind,parent_chat_id,origin_surface,seat_kind,title FROM chats WHERE id=?").get(row.parent_chat_id) as ChannelRow | undefined;
  if (!parent || !isGroupRoom(parent) || !isRosterMember(db, input.agentId)) return null;
  const roomChatId = row.parent_chat_id as string, seatId = rosterMemberSoloSeatId(db, input.agentId, input.ownerScope);
  const room = rosterMode === "room";
  return resolveAssignment(db, input, mode, { kind: "roster", scopeId: room ? `seat:${seatId}#room:${roomChatId}` : `seat:${seatId}`, actorKey: `agent:${input.agentId}`, seat: null,
    candidates: () => chooseRosterCandidates(db, input.ownerScope, input.agentId, room ? { room: { roomChatId } } : { shared: { seatId } }) }, channel);
}

/** The conversation looks like a dispatch child of a member from its own row alone: everything the resolver reads first, before the first database read that can fail. */
function rosterShape(row: { agentId: string | null; kind: string | null; origin: string | null }, input: SessionScopeInput): boolean {
  return row.origin === "one" && row.kind === "division" && !!input.parentChatId && row.agentId === input.agentId
    && input.agentId !== BUILTIN_ONE_AGENT_ID && !!input.agentId.trim() && !!input.ownerScope.trim();
}

/** The seat id when the conversation row is a seat conversation of the agent the turn is for; null for every other conversation. */
function seatOf(row: { agentId: string | null; kind: string | null; origin: string | null; seatId: string | null; seatKind: string | null }, input: SessionScopeInput): string | null {
  const solo = row.origin === "one" && row.kind === "user" && row.seatKind === "solo" && !!row.seatId
    && row.agentId === input.agentId && input.agentId !== BUILTIN_ONE_AGENT_ID && !!input.agentId.trim() && !!input.ownerScope.trim();
  return solo ? row.seatId : null;
}
/** The machine cause of a failure: a SQLite code or this module's own code, never a message. */
export function sessionScopeFailureCause(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : "";
  if (/^SQLITE_[A-Z_]+$/.test(code)) return code;
  const message = error instanceof Error ? error.message : "";
  return /^session_scope_[a-z_]+$/.test(message) ? message : "session_scope_resolve_failed";
}

export function resolveSessionScope(db: Database.Database, input: SessionScopeInput): ResolvedSessionScope {
  const old = (mode: SessionScopeMode, fallback: "error" | null, failure: string | null = null, unavailable = false): ResolvedSessionScope => ({
    kind: "legacy", mode, shared: false, scopeId: null, actorKey: null, seat: null, assignment: null, fallback, unavailable,
    failure: failure ? { causeCode: failure } : null,
    channel: deriveSessionChannel(db, input.chatId, input.aliveController),
    visibilityDomain: legacyVisibilityDomain({ chatId: input.chatId, kind: input.kind, parentChatId: input.parentChatId }, input.aliveController) });
  // Known as soon as the conversation row is: a failure after that point concerns a seat conversation or a member's dispatch child.
  let seatId: string | null = input.chat ? seatOf(input.chat, input) : null;
  let member = !!input.chat && rosterShape(input.chat, input);
  try {
    const mode = sessionScopeMode(db);
    if (mode === "chat" || input.aliveController) return old(mode, null);
    const row = db.prepare("SELECT agent_id,kind,parent_chat_id,origin_surface,seat_id,seat_kind FROM chats WHERE id=?").get(input.chatId) as ChatRow | undefined;
    if (!row) return old(mode, null);
    seatId = seatOf({ agentId: row.agent_id, kind: row.kind, origin: row.origin_surface, seatId: row.seat_id, seatKind: row.seat_kind }, input);
    member = rosterShape({ agentId: row.agent_id, kind: row.kind, origin: row.origin_surface }, { ...input, parentChatId: row.parent_chat_id });
    if (seatId) return resolveSeat(db, input, mode, seatId, deriveSessionChannel(db, input.chatId, false));
    if (member) {
      const scoped = resolveRosterChild(db, input, mode, row, deriveSessionChannel(db, input.chatId, false));
      if (scoped) return scoped;
    }
    return old(mode, null);
  } catch (error) {
    const cause = sessionScopeFailureCause(error);
    const refused = (seatId !== null || member) && !input.aliveController;
    console.warn(`[session-scope] resolve failed (${cause})${refused ? ", this turn is refused rather than split from its shared session" : ", using the conversation's own journal"}`);
    return old("chat", "error", cause, refused);
  }
}

/**
 * Every journal domain a seat scope assigned to this agent under this owner scope (one record per scope the agent has a session in).
 * A turn digest, a recall or a rollback that looks for the journal a conversation's turns went to reads these besides the
 * conversation's own formula: after an assignment, a roster member's dispatch child writes to the member's journal.
 */
export function assignedSeatDomains(db: Pick<Database.Database, "prepare">, ownerScope: string, agentId: string): string[] {
  if (!ownerScope.trim() || !agentId.trim()) return [];
  const rows = db.prepare("SELECT key,value FROM meta WHERE key LIKE ? ESCAPE '\\'").all(`${ACTOR_KEY_PREFIX.replace(/[%_\\]/g, "\\$&")}${ownerScope.slice(0, 16)}|seat:%`) as Array<{ key: string; value: string }>;
  const suffix = `|agent:${agentId}`, domains: string[] = [];
  for (const row of rows) {
    if (!row.key.endsWith(suffix)) continue;
    const stored = parseAssignment(row.value) ?? ((): StoredAssignment | null => { const salvage = salvageAssignment(row.value); return salvage.domain ? { v: 1, domain: salvage.domain, adoptedFrom: salvage.adoptedFrom, retained: salvage.retained, at: "" } : null; })();
    if (stored && !domains.includes(stored.domain)) domains.push(stored.domain);
  }
  return domains;
}

/**
 * The journals a conversation's turns can be found in: its own old domain, and the domain its seat scope assigned to its agent.
 * Reading only: never stores an assignment, whatever the switches say now (turns that ran under a scope stay readable after a rollback).
 */
export function journalDomainsOfConversation(db: Pick<Database.Database, "prepare">, input: { ownerScope: string; agentId: string; chatId: string; kind: string | null; parentChatId: string | null }): string[] {
  const own = legacyVisibilityDomain({ chatId: input.chatId, kind: input.kind, parentChatId: input.parentChatId }, false);
  let assigned: string[] = [];
  try { assigned = assignedSeatDomains(db, input.ownerScope, input.agentId); } catch { /* the conversation's own domain is still readable */ }
  return [own, ...assigned.filter(domain => domain !== own)];
}

/**
 * Whether the journal `identity` names is the session of a roster member that is on the roster now: the background service keeps
 * such a session's resident process awake (daemon/agent-context-host.ts awakeLifetime). Either the journal is a seat scope's
 * assignment for this agent, or (as before) it is the journal of the member's own dispatch child.
 */
export function rosterSessionIsCurrent(db: Pick<Database.Database, "prepare">, identity: { ownerScope: string; agentId: string; visibilityDomain: string }): boolean {
  if (!isRosterMember(db, identity.agentId)) return false;
  return assignedSeatDomains(db, identity.ownerScope, identity.agentId).includes(identity.visibilityDomain);
}
