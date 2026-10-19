// Session scope: which journal, and so which native session, a conversation's turns belong to.
//
// Until this module every conversation owned its own journal (`chat:<chat id>`), so a new conversation with the same
// agent in the same seat opened a new native session and the agent forgot what its newest session had read. Here a
// one-to-one seat conversation takes its journal from the seat and the agent instead: the first turn after an update
// adopts the newest earlier journal of that agent in that seat BY ITS OLD DOMAIN STRING, so the context key, the
// fingerprint seed and the runner owner string stay exactly what that journal's own conversation used (an adopted
// session resumes under the very handle it had). Nothing is moved or deleted; the other journals stay where they are.
//
// This file must not import Electron: the background service loads the same code as the window process, and both
// must reach the same answer from the same database (the first assignment is written with INSERT OR IGNORE and
// re-read, so whichever process writes first wins).
//
// Safety switch (meta key `session-scope.mode`): `chat` returns the old formula for every conversation; `seat` and
// `full` scope the one-to-one seat conversations (`full` is reserved for later stages and means `seat` today). A
// missing value is `seat`; any other value is read as `chat`. Any failure while resolving returns the old formula.
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
  /**
   * true: the first assignment is stored (turn admission). false: the same answer is computed without writing
   * (recall of memory for a turn that has not been admitted yet) — until a record exists it names the domain the
   * admission will store, unless another process stored a different one in between.
   */
  persist: boolean;
}

export type SessionScopeKind = "legacy" | "seat";
export interface SessionScopeAssignment {
  /** adopted: an earlier journal of this agent in this seat continues; fresh: none existed; existing: stored before. */
  outcome: "adopted" | "fresh" | "existing";
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
  /** The seat columns of the conversation this answer depends on; a later change of them is a changed scope. */
  seat: { seatId: string; seatKind: string } | null;
  assignment: SessionScopeAssignment | null;
  /** The old formula was returned because resolving failed (never because of the switch). */
  fallback: "error" | null;
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

/** The conversations whose one-to-one journals a seat's agent may continue: user conversations of that solo seat. */
const SEAT_CHAT_PREDICATE = "c.seat_id=? AND c.seat_kind='solo' AND c.kind='user' AND c.origin_surface='one'";

export const sessionScopeActorMetaKey = (ownerScope: string, scopeId: string, actorKey: string): string =>
  `${ACTOR_KEY_PREFIX}${ownerScope.slice(0, 16)}|${scopeId}|${actorKey}`;

interface StoredAssignment { v: 1; domain: string; adoptedFrom: string | null; retained: string[]; at: string }
function parseAssignment(raw: string | undefined | null): StoredAssignment | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredAssignment>;
    if (value?.v !== 1 || typeof value.domain !== "string" || !value.domain.trim() || value.domain.length > 512) return null;
    return { v: 1, domain: value.domain, adoptedFrom: typeof value.adoptedFrom === "string" ? value.adoptedFrom : null,
      retained: Array.isArray(value.retained) ? value.retained.filter((item): item is string => typeof item === "string") : [],
      at: typeof value.at === "string" ? value.at : "" };
  } catch { return null; }
}
const assignmentOf = (stored: StoredAssignment, created: boolean): SessionScopeAssignment => ({
  outcome: created ? (stored.adoptedFrom ? "adopted" : "fresh") : "existing",
  fromDomain: stored.adoptedFrom, retainedDomains: stored.retained, created });

/**
 * The journal an agent's one-to-one conversations in a seat continue: among the owner's journals of this agent whose
 * domain is `chat:<conversation of this seat>`, the one that holds a native session handle comes first, then the most
 * recently written one. The rest are retained as they are.
 */
function chooseSeatCandidates(db: Pick<Database.Database, "prepare">, ownerScope: string, seatId: string, agentId: string): string[] {
  const rows = db.prepare(`SELECT json_extract(h.identity_json,'$.visibilityDomain') AS domain, MAX(h.updated_at) AS updated_at,
      MAX(EXISTS(SELECT 1 FROM agent_context_bindings b WHERE b.context_key=h.context_key AND b.native_handle IS NOT NULL AND b.native_handle<>'')) AS has_handle
    FROM agent_context_heads h
    WHERE json_extract(h.identity_json,'$.ownerScope')=? AND json_extract(h.identity_json,'$.agentId')=?
      AND json_extract(h.identity_json,'$.visibilityDomain') IN (SELECT 'chat:'||c.id FROM chats c WHERE ${SEAT_CHAT_PREDICATE})
    GROUP BY domain ORDER BY has_handle DESC, updated_at DESC, domain ASC`).all(ownerScope, agentId, seatId) as Array<{ domain: string }>;
  return rows.map(row => row.domain).filter(domain => typeof domain === "string" && domain.length > 0);
}

function resolveSeat(db: Database.Database, input: SessionScopeInput, mode: SessionScopeMode, seatId: string): ResolvedSessionScope {
  const scopeId = `seat:${seatId}`, actorKey = `agent:${input.agentId}`, key = sessionScopeActorMetaKey(input.ownerScope, scopeId, actorKey);
  const base = { kind: "seat" as const, mode, shared: true, scopeId, actorKey, seat: { seatId, seatKind: "solo" }, fallback: null };
  const stored = parseAssignment((db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value);
  if (stored) return { ...base, visibilityDomain: stored.domain, assignment: assignmentOf(stored, false) };
  const candidates = chooseSeatCandidates(db, input.ownerScope, seatId, input.agentId);
  const chosen: StoredAssignment = candidates.length
    ? { v: 1, domain: candidates[0], adoptedFrom: candidates[0], retained: candidates.slice(1, 1 + MAX_RETAINED), at: new Date().toISOString() }
    : { v: 1, domain: scopeId, adoptedFrom: null, retained: [], at: new Date().toISOString() };
  if (!input.persist) return { ...base, visibilityDomain: chosen.domain, assignment: assignmentOf(chosen, false) };
  // First writer wins: the window process and the background service may both be here with the same first turn.
  const inserted = db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)").run(key, JSON.stringify(chosen)).changes === 1;
  const winner = parseAssignment((db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value);
  if (!winner) throw new Error("session_scope_assignment_unreadable");
  return { ...base, visibilityDomain: winner.domain, assignment: assignmentOf(winner, inserted) };
}

export function resolveSessionScope(db: Database.Database, input: SessionScopeInput): ResolvedSessionScope {
  const old = (mode: SessionScopeMode, fallback: "error" | null): ResolvedSessionScope => ({
    kind: "legacy", mode, shared: false, scopeId: null, actorKey: null, seat: null, assignment: null, fallback,
    visibilityDomain: legacyVisibilityDomain({ chatId: input.chatId, kind: input.kind, parentChatId: input.parentChatId }, input.aliveController) });
  try {
    const mode = sessionScopeMode(db);
    if (mode === "chat" || input.aliveController) return old(mode, null);
    const row = db.prepare("SELECT agent_id,kind,parent_chat_id,origin_surface,seat_id,seat_kind FROM chats WHERE id=?").get(input.chatId) as ChatRow | undefined;
    if (!row) return old(mode, null);
    const solo = row.origin_surface === "one" && row.kind === "user" && row.seat_kind === "solo" && !!row.seat_id
      && row.agent_id === input.agentId && input.agentId !== BUILTIN_ONE_AGENT_ID && !!input.agentId.trim() && !!input.ownerScope.trim();
    if (!solo) return old(mode, null);
    return resolveSeat(db, input, mode, row.seat_id!);
  } catch (error) {
    console.warn(`[session-scope] resolve failed, using the conversation's own journal: ${error instanceof Error ? error.message : String(error)}`);
    return old("chat", "error");
  }
}
