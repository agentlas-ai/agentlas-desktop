// K3' - the resting-time gathering (Agentlas 2.0; 11.2-4, 12.2 and 13; decision).
//
// What the owner sees: nobody has to say "remember". When the machine rests, ONE model call reads the turns that piled up since the last gathering and writes what will still matter, as the same memory tickets
// a model writes at the call (ticket-receiver.ts, applied by ticket-call.ts applyTicketReceipt): no second way to write, hide or forget a line. A tip that was worked out in two different projects ends up as ONE line
// in the agent's own memory; something true in one project only stays in that project; what the OWNER wrote in the personal agent's own conversation can become a Personal line.
//
// What it reads: the turn records (memory_tickets + memory_episodes: the host's excerpt of each turn, whoever wrote it - this app or the engine's hook) and, for the turns this app wrote, the host facts in the
// record's `detail_json` (tickets.ts turnHostFacts: who wrote the turn, the owner's own message, whether tools or files came in). The model sees only that, plus the nearest lines it may replace.
//
// What it never does: look for words. Which turn is the owner's, which project a turn belongs to, how many different projects confirmed a tip are host facts; what a turn means is the model's to read.
// Which model: the one the machine uses now (the caller's `call`); no model, or a model that cannot answer, means this pass is skipped and the next signal tries again - nothing here stops, counts failures
// by itself or asks for a better model.
// When: only on a signal the caller's idle job already has (idle, pile size, app start). The pile is read, never polled; nothing pending = no model call; the same pile read twice cannot happen because a gathered
// turn is marked (`detail_json.g`) in the same transaction that ends the batch.
//
// Crash safety: a batch is one row of memory_dreaming_sources (state processing -> answered -> gone). The model's answer is stored BEFORE any line is written and the row keeps how many tickets were applied, so a
// kill after the read, after the answer or half way through the tickets is finished by the next start from the stored answer (no second model call, no line twice: a ticket applied twice is a merge).
import { createHash, randomUUID } from "node:crypto";
import { getMemoryDb, getMemoryStoreInfo, memoryRoot } from "./database";
import { storeSkips } from "./stores";
import { getMeta, setMeta } from "../store/meta";
import { memoryActorKind } from "../../shared/memory-ownership";
import { looksSecret } from "../../shared/secret-patterns";
import { loadCuratorRuleset } from "./curator-rules";
import { receiveTickets, ticketToolText, type TicketHostFacts } from "./ticket-receiver";
import type { ShownLine } from "./ticket-call";
import type { CurationContext } from "./curator";
import { appendMemoryOrigins, listMemoryForContext, supersedeMemoryEntries, type MemoryEntry } from "./store";
import { autoLocalEmbedding, rankHybridLocal } from "./local-embedding";
import { composeDeclaredPrompt } from "../runtime/prompt-order";

// The write half (ticket-call.ts: the owner mutations, the harness caller, the curator) is loaded when a pass first needs it, not when the idle job module is: a pass is rare, and importing it eagerly would put
// the one write gate and the home state into the load of every process that merely schedules memory work.
const ticketCall = () => require("./ticket-call") as typeof import("./ticket-call"); // eslint-disable-line @typescript-eslint/no-require-imports
import { getProject, listProjects } from "../store/projects";
import { projectHashCandidates } from "./tickets";

/**
 * The switch that keeps this file off until the four per-turn jobs it replaces (the turn-end curation job, the semantic review, the "request received" line, the translation worker) are gone from the same build:
 * both on would be MORE model calls, not fewer. Flipped by the commit that deletes them.
 */
const PER_TURN_JOBS_GONE = true;
export function gatheringEnabled(): boolean { return PER_TURN_JOBS_GONE && ticketToolText() !== null && gatheringRules() !== null; }

// ── the text and the values (the ruleset's `curator.gathering`, 1.15.0: ONE source for every surface; each value there says what it rests on and what happens when it is reached) ─────────────────────
/**
 * Everything this call says and every number it uses is read from the shipped ruleset copy (electron/memory/curator-ruleset.json = the engine's system-agents/curator-ruleset.json): the system text (`text`), the line that
 * introduces the ticket shape (`shapeLead`) and the eight values (`values.<name>.value`, each with its `basis` and `reached` there - the code keeps no second copy of them). A ruleset copy without that section (an older
 * copy, or one whose text or a value is unreadable) means the gathering does not run: the next signal asks again after the copy is updated, and no text of this file's own is ever sent in its place.
 */
export interface GatherValues {
  /** A pass opens when this many turn records are waiting. Reached: one call (up to maxTurnsPerCall turns). */
  minTurns: number;
  /** ... or this many turns the OWNER wrote in the personal agent's own conversation. */
  minPersonalOwnerTurns: number;
  /** ... or the oldest waiting record is this old at the next signal (no timer). Reached: a pile of any size is gathered once. */
  maxWaitMs: number;
  /** Turns in one model call. Reached: the rest waits for the next call (same pass or the next pass). */
  maxTurnsPerCall: number;
  /** Bytes of the input of one call. Reached: the ruleset's fit steps run in their order. */
  maxBytesPerCall: number;
  /** Model calls in one pass. Reached: the pass ends and the next pass (the idle job's own spacing) reads the rest. */
  maxCallsPerPass: number;
  /** Tickets applied from one answer. Reached: the rest are dropped and counted. */
  maxTicketsPerAnswer: number;
  /** A pile the model answered with something unreadable is not asked again for this long (no extra calls to cover a model's gap); a bigger pile at once. */
  unreadableAnswerWaitMs: number;
}
interface GatheringRules {
  text: string; shapeLead: string; values: GatherValues;
  /** The ids the ruleset declares for the two modules: they must be the ids this file registers, else the copy is not the one this build was written against. */
  moduleId: string; shapeModuleId: string;
}
const GATHER_VALUE_NAMES: ReadonlyArray<keyof GatherValues> = ["minTurns", "minPersonalOwnerTurns", "maxWaitMs", "maxTurnsPerCall", "maxBytesPerCall", "maxCallsPerPass", "maxTicketsPerAnswer", "unreadableAnswerWaitMs"];
const GATHER_SYSTEM_MODULE = "memory.gathering.system";
const GATHER_SHAPE_MODULE = "memory.gathering.ticket-shape";
/** The gathering section of the shipped ruleset, or null when it is not all there (then nothing is invented: the pass does not run). */
export function gatheringRules(): GatheringRules | null {
  try {
    const section = (loadCuratorRuleset().ruleset as unknown as { curator?: { gathering?: Record<string, unknown> } }).curator?.gathering;
    if (!section || typeof section !== "object") return null;
    const text = section.text, shapeLead = section.shapeLead;
    if (typeof text !== "string" || !text.trim() || typeof shapeLead !== "string" || !shapeLead.trim()) return null;
    const rawValues = section.values as Record<string, { value?: unknown }> | undefined;
    if (!rawValues || typeof rawValues !== "object") return null;
    const values = {} as GatherValues;
    for (const name of GATHER_VALUE_NAMES) {
      const value = rawValues[name]?.value;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
      values[name] = value;
    }
    const moduleId = (section.module as { id?: unknown } | undefined)?.id, shapeModuleId = (section.shapeModule as { id?: unknown } | undefined)?.id;
    if (moduleId !== GATHER_SYSTEM_MODULE || shapeModuleId !== GATHER_SHAPE_MODULE) return null;
    return { text, shapeLead, values, moduleId, shapeModuleId };
  } catch { return null; }
}
/** The values of the loaded copy for the code that only runs behind `gatheringEnabled()`. */
function gv(): GatherValues {
  const rules = gatheringRules();
  if (!rules) throw new Error("gathering_ruleset_missing");
  return rules.values;
}
/** Lease on a batch while the model answers / while tickets are applied (the dreaming window uses the model timeout + 30 s). Applying is local SQL; 2 minutes. */
const APPLY_LEASE_MS = 120_000;
const SINCE_KEY = "memory_gather_since";
const BAD_ANSWER_KEY = "memory_gather_bad_answer";
const SCOPE_PREFIX = "gather:";
const WRAPPER_VERSION = 1;

export const GATHER_SCHEMA = "agentlas.memory-curation-input.v2";

// ── the prompt (registered modules; fixed first, the turns last) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Modules `memory.gathering.system` (fixed-policy, change cause: release; the text is the ruleset's `curator.gathering.text`, word for word), `memory.ticket.tool` (the ruleset's memory_ticket text, word for word) and
 * `memory.gathering.ticket-shape` (the ruleset's `shapeLead` + the memory_ticket tool's own input schema, the engine's schemas/memory-ticket.v2.schema.json, which this call has no tool definition to carry). A model that
 * is told only the tool's prose leaves out `source` and `quote`, and the receiver then reads every line as a guess (measured, real claude-code: 3 of 3 Personal tickets of the personal conversation came back
 * without them and were refused as `not_said`; once the shape was given they came back with `permission: true` and were refused as `needs_approval` - the text now says so in its `permission:` line).
 */
function gatheringSystemPrompt(): string | null {
  const rules = ticketToolText();
  const gathering = gatheringRules();
  if (!rules || !gathering) return null;
  let shape: string | null = null;
  try {
    const schema = (require("../turn-tools/mcp-server") as typeof import("../turn-tools/mcp-server")).MEMORY_TICKET_INPUT_SCHEMA as { properties: { tickets: { items: unknown } } }; // eslint-disable-line @typescript-eslint/no-require-imports
    shape = `${gathering.shapeLead}${JSON.stringify(schema.properties.tickets.items)}`;
  } catch { shape = null; /* the tool text alone: the receiver still reads every ticket as far as it is filled */ }
  return composeDeclaredPrompt([
    { id: "memory.gathering.system", revision: WRAPPER_VERSION, stability: "fixed-policy", changeTriggers: ["release"], order: 0, text: gathering.text },
    { id: "memory.ticket.tool", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], order: 10, text: rules },
    { id: "memory.gathering.ticket-shape", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], order: 20, text: shape },
  ], "\n\n");
}

// ── turn records ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
interface TurnFacts { v?: number; own?: number; pers?: number; tl?: number; in?: number; req?: string; g?: number }
interface PendingRow {
  rid: number; episodeId: string; ticketId: string; runId: string | null; agentId: string | null; chatId: string | null; projectId: string | null; projectHash: string | null;
  summary: string; detail: TurnFacts; createdAt: string;
}

function parseFacts(raw: string | null): TurnFacts {
  if (!raw) return {};
  try { const value = JSON.parse(raw) as unknown; return value && typeof value === "object" && !Array.isArray(value) ? value as TurnFacts : {}; } catch { return {}; }
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The instant before which a turn record is not this pass's business (K5' reads the older ones in its one long gathering). Set once, on the first look; a second process that sets it a moment later changes nothing that matters. */
function sinceInstant(db: ReturnType<typeof getMemoryDb>, override?: string | null): string {
  if (override !== undefined && override !== null) return override;
  let since = getMeta(SINCE_KEY);
  if (!since) { since = new Date().toISOString(); setMeta(SINCE_KEY, since); }
  void db;
  return since;
}

const PENDING_WHERE = `e.summary IS NOT NULL AND e.created_at > ? AND t.state = 'completed' AND t.emitter_status <> 'read_only' AND t.failure_code IS NULL
  AND (e.detail_json IS NULL OR NOT json_valid(e.detail_json) OR json_extract(e.detail_json, '$.g') IS NULL)
  AND NOT EXISTS (SELECT 1 FROM memory_episode_quarantines q WHERE q.ticket_id = e.ticket_id)`;

export interface GatherDue { pending: number; personalOwner: number; oldestAt: string | null }

/** A few single-row reads: how many turn records wait, how many of them are the owner's own words in the personal agent's conversation, and when the oldest was written. No writes except the first look's `since`. */
export function gatherDueState(options: { since?: string | null } = {}): GatherDue {
  const db = getMemoryDb();
  const since = sinceInstant(db, options.since);
  const row = db.prepare(`SELECT COUNT(*) AS n, MIN(e.created_at) AS oldest,
      SUM(CASE WHEN json_valid(e.detail_json) AND json_extract(e.detail_json,'$.own') = 1 AND json_extract(e.detail_json,'$.pers') = 1 THEN 1 ELSE 0 END) AS personal
    FROM memory_episodes e JOIN memory_tickets t ON t.ticket_id = e.ticket_id WHERE ${PENDING_WHERE}`).get(since) as { n: number; oldest: string | null; personal: number | null };
  return { pending: Number(row.n) || 0, personalOwner: Number(row.personal) || 0, oldestAt: row.oldest };
}

/** When a gathering pass may start: 0 = now (when the machine is idle), null = nothing worth a call. Pure over the due state and the clock. */
export function gatherDueAt(state: GatherDue, now = Date.now()): number | null {
  const values = gatheringRules()?.values;
  if (!values || state.pending <= 0) return null; // no section in the copy: nothing is due (the next signal looks again after the copy is updated)
  if (state.pending >= values.minTurns || state.personalOwner >= values.minPersonalOwnerTurns) return 0;
  const oldest = state.oldestAt ? Date.parse(state.oldestAt) : NaN;
  if (Number.isFinite(oldest) && now - oldest >= values.maxWaitMs) return 0;
  // Younger than the age rule: the pile is looked at again at the moment its oldest record turns that old (the idle job aims one look there; a signal looks earlier).
  return Number.isFinite(oldest) ? oldest + values.maxWaitMs : null;
}

/**
 * K3'-2b: a turn record the engine's hook wrote names its folder by a hash only (`project_path_hash`, no project id): the hash of the spelling the hook saw (tickets.ts projectHashCandidates). Here the record is matched to the
 * desktop project whose folder has that hash under any spelling the engine could have written, so the turn counts for that project - its lines can be written, and a tip that two PROJECTS confirmed is counted as two, not as
 * the same project under two keys. The match is made in memory only (the record is not rewritten); a hash no known folder explains stays a hash (the turn is still read, it just cannot write a project line). Folders are
 * looked at only when a pending record has a hash and no project id - a pile of the desktop's own turns costs nothing here.
 */
function adoptKnownProjects(rows: PendingRow[]): void {
  const wanted = new Set<string>();
  for (const row of rows) if (!row.projectId && row.projectHash) wanted.add(row.projectHash);
  if (wanted.size === 0) return;
  const found = new Map<string, string>();
  try {
    for (const project of listProjects()) {
      if (!project.folderPath) continue;
      for (const hash of projectHashCandidates(project.folderPath)) if (wanted.has(hash) && !found.has(hash)) found.set(hash, project.id);
      if (found.size === wanted.size) break;
    }
  } catch { return; /* no project list now: the records stay hashes and are read as before */ }
  for (const row of rows) if (!row.projectId && row.projectHash) row.projectId = found.get(row.projectHash) ?? null;
}

/** True when `hash` is the folder's hash under any spelling the desktop or the engine could have written. The record keeps a one-way hash of the folder, so this is how a project folder is accepted for a line. */
function folderHasHash(folder: string | null | undefined, hash: string | null): boolean {
  return Boolean(folder && hash && projectHashCandidates(folder).includes(hash));
}

function readPending(db: ReturnType<typeof getMemoryDb>, since: string, limit: number): PendingRow[] {
  const rows = db.prepare(`SELECT e.rowid AS rid, e.episode_id AS episodeId, e.ticket_id AS ticketId, t.run_id AS runId, e.agent_id AS agentId, e.chat_id AS chatId, e.project_id AS projectId,
      e.project_path_hash AS projectHash, e.summary AS summary, e.detail_json AS detail, e.created_at AS createdAt
    FROM memory_episodes e JOIN memory_tickets t ON t.ticket_id = e.ticket_id WHERE ${PENDING_WHERE} ORDER BY e.created_at, e.rowid LIMIT ?`).all(since, limit) as Array<Omit<PendingRow, "detail"> & { detail: string | null }>;
  const pending = rows.map(row => ({ ...row, detail: parseFacts(row.detail) }));
  adoptKnownProjects(pending);
  return pending;
}

/** Marks turn records as gathered (or as not for gathering: a hub-called agent keeps no memory,). One statement per 400. */
function markGathered(db: ReturnType<typeof getMemoryDb>, episodeIds: readonly string[], at: number): void {
  for (let start = 0; start < episodeIds.length; start += 400) {
    const part = episodeIds.slice(start, start + 400);
    db.prepare(`UPDATE memory_episodes SET detail_json = json_set(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END, '$.g', ?) WHERE episode_id IN (${part.map(() => "?").join(",")})`).run(at, ...part);
  }
}

/** The owner's words in a record a forget emptied are gone (the trigger of tickets.ts does it at the moment of the forget; this is the belt for a store that could not take the trigger). */
function sweepForgottenFacts(db: ReturnType<typeof getMemoryDb>): void {
  try { db.prepare("UPDATE memory_episodes SET detail_json = NULL WHERE summary IS NULL AND detail_json IS NOT NULL").run(); } catch { /* an old store without the column: nothing to sweep */ }
}

// ── batches ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
interface Batch {
  groupKey: string;
  actorId: string | null;
  personal: boolean;
  rows: PendingRow[];
}

/** A group is what one call can speak for: one actor, and the personal agent's own conversation apart from the rest (the receiver answers per conversation kind). `skip` = groups this pass has set aside (a store they need could not be read). */
function nextBatch(db: ReturnType<typeof getMemoryDb>, since: string, skip: ReadonlySet<string> = new Set()): { batch: Batch | null; skipped: string[] } {
  const rows = readPending(db, since, 400);
  const skipped: string[] = [];
  const groups = new Map<string, PendingRow[]>();
  for (const row of rows) {
    // A hub-called agent keeps no memory of the owner's; a record with no actor cannot be placed. Neither is ever gathered: they leave the pile so it can end.
    if (!row.agentId || memoryActorKind(row.agentId) === "hub") { skipped.push(row.episodeId); continue; }
    const key = `${row.agentId}|${row.detail.pers === 1 ? 1 : 0}`;
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  const first = [...groups.entries()].find(([key]) => !skip.has(key));
  if (!first) return { batch: null, skipped };
  const [groupKey, all] = first;
  const picked = all.slice(0, gv().maxTurnsPerCall);
  return { batch: { groupKey, actorId: picked[0].agentId, personal: picked[0].detail.pers === 1, rows: picked }, skipped };
}

/**
 * K3'-2a: the stores this batch reads and writes (its agent's own store and the store of every project its turns were worked in) that cannot be read right now: `store:code` strings, empty when all can.
 * With the layout switch off there is no store but the root and this is always empty. A store that does not exist yet is normal (an agent with no line has no file) and is not listed; a store that only still has a
 * forget to catch up on (`forget_catchup_withheld`) is read as far as it can be - the lines it hides are the ones the owner forgot, so what the model sees is right - and is not listed either.
 * Why it matters: the model is shown the lines nearest to the turns so that it rewrites or merges instead of writing a second copy. Shown only the root's half, it would write copies of lines it could not see, and
 * a line whose own store cannot be opened is written to the root instead (store-write.ts). So the batch waits - its turn records stay unmarked, nothing is read twice or lost - and the next signal looks again.
 */
function unreadableStoresOf(batch: Batch): string[] {
  const codes = new Set<string>();
  try {
    const db = getMemoryDb();
    const context = { memoryRoot: memoryRoot(), owner: getMemoryStoreInfo().ownerNamespace, rootDb: db };
    const scopes = new Map<string, { agentId: string | null; projectId: string | null; projectPath: string | null }>();
    for (const row of batch.rows) {
      const projectId = row.projectId;
      let path: string | null = null;
      if (projectId) { try { const folder = getProject(projectId)?.folderPath ?? null; path = folderHasHash(folder, row.projectHash) ? folder : null; } catch { path = null; } }
      scopes.set(`${projectId ?? ""}|${path ?? ""}`, { agentId: batch.actorId, projectId, projectPath: path });
    }
    for (const scope of scopes.values()) for (const skip of storeSkips(context, scope)) if (skip.code !== "forget_catchup_withheld") codes.add(`${skip.kind}:${skip.code}`);
  } catch { /* a probe that cannot run says nothing: the read below is what decides */ }
  return [...codes].sort();
}

// ── the packet (built by code, never by a model; the engine's input v2 plus the two fields a multi-project call needs: p and the host flags) ───────────────────────────────────────────────────────────
interface PacketTurn { i: number; p: number; request: string; summary: string; extract: string; host: { status: "ok"; tools: null; tool_failures: null; files_changed: null; verified: null; owner_correction: boolean; tools_ran: boolean; inputs_read: boolean } }
interface PacketLine { ref: string; kind: string; scope: string; content: string; p: number }
interface Packet {
  schema_version: typeof GATHER_SCHEMA;
  boundary: { conversation: "personal" | "work_session" | "agent_chat"; project_bound: boolean; agent_bound: boolean; subject: "resident" | "folderAgent" | "special"; owner_spoke_turns: number[] };
  turns: PacketTurn[];
  related: PacketLine[];
  omitted: number;
}
const compactJson = (value: unknown) => JSON.stringify(value);
const sizeOf = (packet: Packet) => Buffer.byteLength(compactJson(packet), "utf8");

interface InputRules { requestMaxChars: number; summaryMaxChars: number; extractMaxChars: number; relatedMax: number; relatedContentMaxChars: number; fitSteps: Array<{ step: string; action: string; chars?: number; walk?: string; keepOwnerSpoke?: boolean; keepNewest?: boolean }> }
function inputRules(): InputRules {
  const input = (loadCuratorRuleset().ruleset as unknown as { curator?: { input?: Partial<InputRules> } }).curator?.input ?? {};
  return { requestMaxChars: input.requestMaxChars ?? 600, summaryMaxChars: input.summaryMaxChars ?? 360, extractMaxChars: input.extractMaxChars ?? 400,
    relatedMax: input.relatedMax ?? 8, relatedContentMaxChars: input.relatedContentMaxChars ?? 300, fitSteps: input.fitSteps ?? [] };
}

interface ProjectRef { number: number; projectId: string | null; hash: string | null; path: string | null }
function projectKey(row: PendingRow): string | null { return row.projectId ?? row.projectHash; }

/** The packet and the maps a ticket is checked against afterwards (turn number -> record, project number -> project, line ref -> shown line). */
interface BuiltPacket { packet: Packet; included: PendingRow[]; turnByNumber: Map<number, PendingRow>; projects: Map<number, ProjectRef>; lines: Map<string, ShownLine & { p: number }>; json: string }

function relatedLinesFor(batch: Batch, projects: Map<number, ProjectRef>, rules: InputRules): Array<ShownLine & { p: number }> {
  const out = new Map<string, ShownLine & { p: number }>();
  const turnText = batch.rows.map(row => `${row.detail.req ?? ""} ${row.summary}`).join("\n").slice(0, 4_000);
  const stores: Array<{ p: number; scope: { agentId: string | null; projectId: string | null; projectPath: string | null; chatId: string | null } }> = [];
  for (const [number, project] of projects) stores.push({ p: number, scope: { agentId: batch.actorId, projectId: project.projectId, projectPath: project.path, chatId: null } });
  if (!stores.length) stores.push({ p: 0, scope: { agentId: batch.actorId, projectId: null, projectPath: null, chatId: null } });
  for (const store of stores) {
    let entries: MemoryEntry[] = [];
    try { entries = listMemoryForContext(store.scope, -1); } catch { entries = []; }
    // The personal group may change the owner's own lines; every other group never sees them (a remove or rewrite of a Personal line needs the personal conversation).
    entries = entries.filter(entry => batch.personal ? entry.scope === "user_identity" || entry.scope === "agent_repo" || entry.scope === "project" : entry.scope === "agent_repo" || entry.scope === "project");
    // Project lines belong to their project; agent lines are shown once.
    entries = entries.filter(entry => entry.scope !== "project" || (store.scope.projectId !== null && entry.projectId === store.scope.projectId) || (entry.projectPath !== null && entry.projectPath === store.scope.projectPath));
    let nearest = entries.slice(0, rules.relatedMax);
    if (entries.length > rules.relatedMax && turnText.trim()) {
      try {
        const ranked = rankHybridLocal(turnText, entries.map(entry => ({ id: entry.id, text: entry.content, embedding: entry.embedding.vector, entry })))
          .filter(result => result.lexicalScore > 0 || result.semanticEligible).slice(0, rules.relatedMax).map(result => result.item.entry);
        if (ranked.length) nearest = ranked;
      } catch { /* the newest lines are shown as before */ }
    }
    for (const entry of nearest) {
      const shown = ticketCall().shownLineOf(entry.id);
      if (shown && !out.has(shown.id)) out.set(shown.id, { ...shown, p: entry.scope === "project" ? store.p : 0 });
    }
  }
  return [...out.values()];
}

function buildPacket(batch: Batch): BuiltPacket | null {
  const rules = inputRules();
  const projects = new Map<number, ProjectRef>();
  const numberOf = new Map<string, number>();
  const turns: PacketTurn[] = [];
  const turnByNumber = new Map<number, PendingRow>();
  batch.rows.forEach((row, index) => {
    let p = 0;
    const key = projectKey(row);
    if (key) {
      let number = numberOf.get(key);
      if (!number) {
        number = numberOf.size + 1; numberOf.set(key, number);
        // The folder a project line is written with: the project's own folder, accepted only when it is the folder this turn recorded (the record keeps a one-way hash of it). A moved or deleted folder writes nothing.
        let path: string | null = null;
        if (row.projectId) { try { const folder = getProject(row.projectId)?.folderPath ?? null; path = folderHasHash(folder, row.projectHash) ? folder : null; } catch { path = null; } }
        projects.set(number, { number, projectId: row.projectId, hash: row.projectHash, path });
      }
      p = number;
    }
    const request = String(row.detail.req ?? "").slice(0, rules.requestMaxChars);
    turns.push({ i: index + 1, p, request, summary: row.summary.slice(0, rules.summaryMaxChars), extract: "",
      host: { status: "ok", tools: null, tool_failures: null, files_changed: null, verified: null, owner_correction: false, tools_ran: row.detail.tl === 1, inputs_read: row.detail.in === 1 } });
    turnByNumber.set(index + 1, row);
  });
  const lines = new Map<string, ShownLine & { p: number }>();
  for (const line of relatedLinesFor(batch, projects, rules)) lines.set(line.id, line);
  const actor = memoryActorKind(batch.actorId);
  const packet: Packet = {
    schema_version: GATHER_SCHEMA,
    boundary: { conversation: batch.personal ? "personal" : actor === "folderAgent" || actor === "special" ? "agent_chat" : "work_session", project_bound: projects.size > 0, agent_bound: true,
      subject: actor === "folderAgent" ? "folderAgent" : actor === "special" ? "special" : "resident", owner_spoke_turns: turns.filter(turn => turnByNumber.get(turn.i)!.detail.own === 1).map(turn => turn.i) },
    turns,
    related: [...lines.values()].map(line => ({ ref: line.id, kind: line.ticket_kind || line.kind, scope: line.scope, content: String(line.text ?? "").replace(/\s+/g, " ").slice(0, rules.relatedContentMaxChars), p: line.p })),
    omitted: 0,
  };
  // The ruleset's fit steps, in their order, each stopping the whole fitting as soon as the size is within the limit (; curator.input.fitRule).
  const droppedTurns = new Set<number>();
  const maxBytes = gv().maxBytesPerCall;
  const within = () => sizeOf(packet) <= maxBytes;
  const owner = (turn: PacketTurn) => turnByNumber.get(turn.i)!.detail.own === 1;
  fitting: for (const step of rules.fitSteps) {
    if (within()) break;
    const order = step.walk === "last-first" ? (items: unknown[]) => [...items.keys()].reverse() : (items: unknown[]) => [...items.keys()];
    if (step.step === "extract" && step.action === "clear") { for (const index of order(packet.turns)) { packet.turns[index].extract = ""; if (within()) break fitting; } }
    else if (step.step === "related" && step.action === "cut") { for (const index of order(packet.related)) { packet.related[index].content = packet.related[index].content.slice(0, step.chars ?? 150); if (within()) break fitting; } }
    else if (step.step === "request" && step.action === "cut") { for (const index of order(packet.turns)) { packet.turns[index].request = packet.turns[index].request.slice(0, step.chars ?? 200); if (within()) break fitting; } }
    else if (step.step === "summary" && step.action === "cut") { for (const index of order(packet.turns)) { packet.turns[index].summary = packet.turns[index].summary.slice(0, step.chars ?? 160); if (within()) break fitting; } }
    else if (step.step === "turn" && step.action === "drop") {
      for (const index of order(packet.turns)) {
        const turn = packet.turns[index];
        if (droppedTurns.has(turn.i) || (step.keepNewest && index === packet.turns.length - 1) || (step.keepOwnerSpoke && owner(turn))) continue;
        droppedTurns.add(turn.i);
        packet.turns = packet.turns.filter(item => item.i !== turn.i); packet.omitted += 1;
        if (within()) break fitting;
      }
    }
  }
  if (!packet.turns.length) return null;
  packet.boundary.owner_spoke_turns = packet.turns.filter(owner).map(turn => turn.i);
  const included = batch.rows.filter((_, index) => packet.turns.some(turn => turn.i === index + 1));
  return { packet, included, turnByNumber, projects, lines, json: compactJson(packet) };
}

// ── the answer ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The model's text -> its list of tickets, or null when nothing readable (an unusable answer is a failed call; `{"tickets":[]}` is an answer). */
export function parseGatherAnswer(text: string | null): unknown[] | null {
  if (!text) return null;
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as { tickets?: unknown };
    return value && Array.isArray(value.tickets) ? value.tickets : null;
  } catch { return null; }
}

interface Stored { answer: unknown[]; episodes: string[]; applied: number; counts: GatherCounts; epoch: number }
export interface GatherCounts { tickets: number; written: number; merged: number; refused: number; dropped: number; promoted: number; scopeDowngraded: number }
const emptyCounts = (): GatherCounts => ({ tickets: 0, written: 0, merged: 0, refused: 0, dropped: 0, promoted: 0, scopeDowngraded: 0 });

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** What one ticket rests on: the turns it cites (numbers) and the lines it cites (refs), checked against what the packet really held. */
function citations(ticket: Record<string, unknown>, built: BuiltPacket): { turns: PendingRow[]; lines: Array<ShownLine & { p: number }> } {
  const turns: PendingRow[] = [], lines: Array<ShownLine & { p: number }> = [];
  const items = Array.isArray(ticket.from) ? ticket.from : ticket.from === undefined || ticket.from === null ? [] : [ticket.from];
  for (const item of items) {
    if (typeof item === "number" || (typeof item === "string" && /^\s*t?\d+\s*$/.test(item))) {
      const row = built.turnByNumber.get(Number(String(item).replace(/\D/g, "")));
      if (row && built.included.includes(row) && !turns.includes(row)) turns.push(row);
    } else if (typeof item === "string") {
      const ref = item.trim().replace(/^\[|\]$/g, "").split(/[\s·]/)[0];
      const line = built.lines.get(ref);
      if (line && !lines.includes(line)) lines.push(line);
    }
  }
  // A model that cites nothing but quotes the person: the turns whose own request holds that quote are the ones it rests on (a provenance check of one string inside another, the same check the receiver makes for the origin;
  // it reads no meaning). Measured on the real claude-code: one of two runs left `from` out of every ticket. No quote, or a quote no request holds: nothing is cited and the ticket is dropped.
  if (!turns.length && typeof ticket.quote === "string") {
    const squash = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
    const quote = squash(ticket.quote);
    if (quote) for (const row of built.included) if (squash(row.detail.req ?? "").includes(quote)) turns.push(row);
  }
  return { turns, lines };
}

function applyTicket(ticket: unknown, built: BuiltPacket, batch: Batch, counts: GatherCounts, assertCustody: () => void): void {
  counts.tickets += 1;
  if (!isObject(ticket)) { counts.dropped += 1; return; }
  const cited = citations(ticket, built);
  // A ticket must rest on at least one turn of this batch: that is where its source, its owner and its project come from (nothing is taken from the model's word).
  if (!cited.turns.length) { counts.dropped += 1; return; }
  // A turn that was forgotten while the model answered no longer speaks (its record was emptied): nothing is written from it.
  const db = getMemoryDb();
  const live = db.prepare(`SELECT summary FROM memory_episodes WHERE episode_id = ?`);
  if (cited.turns.some(row => !(live.get(row.episodeId) as { summary: string | null } | undefined)?.summary)) { counts.dropped += 1; return; }
  const facts = cited.turns.map(row => row.detail);
  const owner = facts.every(fact => fact.own === 1);
  const ownerText = facts.map(fact => fact.req ?? "").filter(Boolean).join("\n") || null;
  const toolsRan = facts.some(fact => fact.tl === 1), inputsRead = facts.some(fact => fact.in === 1);
  // The projects this ticket really rests on - counted by the host from the turns (and project lines) it cites, never from what the model says it is about.
  const projectKeys = new Map<string, PendingRow | (ShownLine & { p: number })>();
  for (const row of cited.turns) { const key = projectKey(row); if (key) projectKeys.set(key, row); }
  for (const line of cited.lines) if (line.scope === "project" && line.p > 0) { const ref = built.projects.get(line.p); const key = ref ? ref.projectId ?? ref.hash : null; if (key) { projectKeys.set(key, line); } }
  const scopeRaw = typeof ticket.scope === "string" ? ticket.scope.trim().toLowerCase() : "";
  let scope = scopeRaw;
  let project: ProjectRef | null = null;
  if (scopeRaw === "agent_repo" || scopeRaw === "project" || scopeRaw === "agent_team" || scopeRaw === "team_memory") {
    const distinct = [...projectKeys.keys()];
    if (scopeRaw === "agent_repo" || scopeRaw === "agent_team" || scopeRaw === "team_memory") {
      if (distinct.length >= 2) { counts.promoted += 1; }                       // confirmed in two different projects: the agent's own memory
      else if (distinct.length === 1) { scope = "project"; counts.scopeDowngraded += 1; }   // one project only: it stays in that project
    }
    if (scope === "project") {
      // The project is the one cited turns belong to; a model's p only breaks a tie between several (a project lesson from a sitting that spans projects).
      const wanted = typeof ticket.p === "number" ? ticket.p : Number(ticket.p);
      const candidates = [...built.projects.values()].filter(ref => projectKeys.has(ref.projectId ?? ref.hash ?? ""));
      project = (candidates.length === 1 ? candidates[0] : candidates.find(ref => ref.number === wanted)) ?? null;
      if (!project || !project.path) { counts.dropped += 1; return; }
    }
  } else if (scopeRaw === "user_identity") {
    // Personal only from the owner's own turns of the personal agent's conversation: the receiver also refuses a Personal ticket on a turn the owner did not write.
    if (!owner || !batch.personal) { counts.refused += 1; return; }
  }
  const actor = memoryActorKind(batch.actorId);
  const conversation = batch.personal ? "personal_agent" : actor === "folderAgent" || actor === "special" ? "folder_agent" : actor === "resident" ? "work_session" : "guest";
  const host: TicketHostFacts = {
    conversation, turn_source: owner ? "owner" : "unknown", project_bound: project !== null, owner_text: ownerText,
    outside_text: inputsRead || toolsRan, tools_ran: toolsRan, receipt: false, visible: [...built.lines.values()],
  };
  const { p: _p, from: _from, ...rest } = ticket;
  void _p; void _from;
  const receipt = receiveTickets({ tickets: [{ ...rest, scope }] }, host);
  if (!receipt || !receipt.items.length) { counts.dropped += 1; return; }
  assertCustody();
  const chats = new Set(cited.turns.map(row => row.chatId));
  const context: CurationContext = {
    turnId: null, projectPath: project?.path ?? null, projectId: project?.projectId ?? null, agentId: batch.actorId, chatId: chats.size === 1 ? [...chats][0] : null,
    ownerSpoke: owner, ...(batch.personal ? { personalConversation: true } : {}), turnFacts: { toolsRan, inputsRead },
  };
  // The runs the cited turn records came from, as the same `run:<id>` evidence a line written at a turn carries: a lesson seen in distinct runs is still counted for a skill (agents/learning-evidence.ts).
  const runRefs = [...new Set(cited.turns.map(row => row.runId).filter((id): id is string => Boolean(id)))].slice(0, 8).map(id => `run:${id}`);
  const applied = ticketCall().applyTicketReceipt({ receipt, context, subject: { personal: batch.personal, agentId: batch.actorId, projectId: project?.projectId ?? null, projectPath: project?.path ?? null }, ownerText, roomContent: false, visible: [...built.lines.values()], evidenceRefs: runRefs });
  const answer = applied.answers[0];
  if (!answer || answer.status !== "ok") { counts.refused += 1; return; }
  if (answer.result === "merged") { counts.merged += 1; return; }
  counts.written += 1;
  const newId = applied.writtenIds[0];
  if (!newId) return;
  // K7'' (audit D7): the link from a line to the turn records it was made from is what a forget follows to empty those records (the turn tickets of the line's origin links). It was cut at 8 turns and its failure was swallowed, so a line
  // made from more turns left the other turns' wording behind, and a failed link left a line nobody could trace. Now every turn the ticket cited is linked (K7''': the store links any number, part by part; a ruleset that raises maxTurnsPerCall cuts nothing),
  // and a link that cannot be written is tried once more. If it still fails the line is hidden again (recoverable, the way a fold hides its sources) and counted as dropped: the choice is "do not write the line" over "write a line that a forget
  // cannot follow". basis: an untraceable line leaves turn wording behind after the owner forgot it; a dropped line costs one lesson that the next confirmation in a later turn makes again.
  const links = cited.turns.map(row => ({ kind: "ticket" as const, id: row.ticketId }));
  let linked = false;
  for (let attempt = 0; attempt < 2 && !linked; attempt += 1) { try { appendMemoryOrigins(newId, links, project?.projectId ?? null); linked = true; } catch { /* once more */ } }
  if (!linked) { try { supersedeMemoryEntries([newId]); } catch { /* the line stays; nothing else can be done here */ } counts.written -= 1; counts.dropped += 1; return; }
  // Confirmed in two projects: the project lines it was made from are folded into the one line (hidden the same recoverable way a condense hides its sources). They are the lines this batch showed the model (its agent's own
  // lines of the projects of its turns) and the ticket cited, so they are retired by their id in whichever file holds them (the root, the project's store). K3'-2a: this went through `supersedeExplicitMemory`, which looks
  // for a line of the SAME scope as the new one (an agent line) and so never found a project line - with the switch off as well as on; a line that could not be retired stays visible and the new line stands.
  if (scopeRaw !== "project" && scope === "agent_repo" && projectKeys.size >= 2) {
    const folded = cited.lines.filter(line => line.scope === "project").map(line => line.memoryId);
    if (folded.length) { try { supersedeMemoryEntries(folded); } catch { /* the new line stands; the older ones stay visible */ } }
  }
}

// ── one pass ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface GatherModelResult { text: string | null; failure?: unknown }
export interface GatherDeps {
  /** The model call of the connected model, no tools (the caller owns the route: orchestrator pool or the active runtime). Null = no model route now: the pass is skipped. */
  call: ((request: { systemPrompt: string; input: string; accept: (text: string) => boolean }) => Promise<GatherModelResult>) | null;
  /** The owner came back (or the pass was told to stop): the next step is not taken. */
  stopped(): boolean;
  /** Throws when the memory source changed under the pass (the owner forgot or edited something): the pass yields. */
  assertCustody(): void;
  /** Test seam: a point of the batch the test may kill the process at ("read", "answer", "applied-half"). Never set in production. */
  at?(point: "read" | "answer" | "applied-half"): void;
  /** Test seam: the instant before which turn records are not gathered (K5' passes the earliest). */
  since?: string | null;
}
export interface GatherOutcome { calls: number; batches: number; counts: GatherCounts; skippedNoModel: boolean; failure?: { code: string }; more: boolean; /** K3'-2a: batches set aside because a store they need could not be read (`store:code`), each tried again at the next signal. */ blocked: Array<{ stores: string[]; turns: number }> }

/** The batch row's table is dreaming's own (dreaming.ts dreamingDb creates the same one); a pass that comes first creates it with the same statement. */
function ensureSourcesTable(db: ReturnType<typeof getMemoryDb>): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_dreaming_sources (
    scope_key TEXT NOT NULL,input_digest TEXT NOT NULL,intake_epoch INTEGER NOT NULL,
    state TEXT NOT NULL,lease_token TEXT,lease_expires_at TEXT,result_json TEXT,
    completed_at TEXT,PRIMARY KEY(scope_key,input_digest,intake_epoch));`);
}

/** A lease token is `<pid>:<uuid>`. A lease whose holder process is gone (killed, crashed) is free at once instead of at its expiry: the restart of a killed app finishes the batch without waiting out the lease. A pid that cannot be probed (another user, another machine's file) counts as alive: the expiry decides. */
const newLease = (): string => `${process.pid}:${randomUUID()}`;
function leaseHolderGone(token: string | null | undefined): boolean {
  const pid = Number(/^(\d+):/.exec(token ?? "")?.[1]);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException)?.code === "ESRCH"; }
}

/** 'ok' = the batch is claimed; 'held' = another live process holds it; 'stale' = the turn records were gathered by someone else between this process's read of the pile and its claim (nothing is claimed; the pile is read again). */
function claimRow(db: ReturnType<typeof getMemoryDb>, scopeKey: string, inputDigest: string, epoch: number, lease: string, leaseMs: number, episodeIds: readonly string[] = []): "ok" | "held" | "stale" {
  return db.transaction((): "ok" | "held" | "stale" => {
    if (episodeIds.length) {
      const waiting = db.prepare(`SELECT COUNT(*) AS n FROM memory_episodes WHERE summary IS NOT NULL AND (detail_json IS NULL OR NOT json_valid(detail_json) OR json_extract(detail_json,'$.g') IS NULL) AND episode_id IN (${episodeIds.map(() => "?").join(",")})`).get(...episodeIds) as { n: number };
      if (waiting.n !== episodeIds.length) return "stale";
    }
    const previous = db.prepare("SELECT state, lease_token, lease_expires_at FROM memory_dreaming_sources WHERE scope_key=? AND input_digest=? AND intake_epoch=?").get(scopeKey, inputDigest, epoch) as { state: string; lease_token: string | null; lease_expires_at: string | null } | undefined;
    if (previous?.lease_expires_at && previous.lease_expires_at > new Date().toISOString() && !leaseHolderGone(previous.lease_token)) return "held";
    db.prepare(`INSERT INTO memory_dreaming_sources VALUES(?,?,?,'processing',?,?,NULL,NULL)
      ON CONFLICT(scope_key,input_digest,intake_epoch) DO UPDATE SET state='processing',lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at`)
      .run(scopeKey, inputDigest, epoch, lease, new Date(Date.now() + leaseMs).toISOString());
    return "ok";
  }).immediate();
}

/** The batches of an earlier pass that this process (or another that died) left half done: finished from the stored answer. Rows whose forget epoch moved are dropped: a forget wins over an answer made before it. */
function resumeAnswered(db: ReturnType<typeof getMemoryDb>, epoch: number): Array<{ key: string; digest: string; stored: Stored }> {
  const out: Array<{ key: string; digest: string; stored: Stored }> = [];
  // A batch that never got its answer holds nothing but a claim: once its lease ended (or its holder is gone) it is let go, and the turn records it covered are asked for again from the pile.
  for (const row of db.prepare("SELECT scope_key AS k, input_digest AS d, intake_epoch AS e, lease_token AS t, lease_expires_at AS l FROM memory_dreaming_sources WHERE scope_key LIKE ? AND state IN ('processing','retry')").all(`${SCOPE_PREFIX}%`) as Array<{ k: string; d: string; e: number; t: string | null; l: string | null }>) {
    if (!row.l || row.l <= new Date().toISOString() || leaseHolderGone(row.t)) db.prepare("DELETE FROM memory_dreaming_sources WHERE scope_key=? AND input_digest=? AND intake_epoch=?").run(row.k, row.d, row.e);
  }
  const rows = db.prepare("SELECT scope_key AS k, input_digest AS d, intake_epoch AS e, result_json AS r, lease_token AS t, lease_expires_at AS l FROM memory_dreaming_sources WHERE scope_key LIKE ? AND state='answered' ORDER BY completed_at, scope_key").all(`${SCOPE_PREFIX}%`) as Array<{ k: string; d: string; e: number; r: string; t: string | null; l: string | null }>;
  for (const row of rows) {
    if (row.e !== epoch) { db.prepare("DELETE FROM memory_dreaming_sources WHERE scope_key=? AND input_digest=? AND intake_epoch=?").run(row.k, row.d, row.e); continue; }
    if (row.l && row.l > new Date().toISOString() && !leaseHolderGone(row.t)) continue;
    try { out.push({ key: row.k, digest: row.d, stored: JSON.parse(row.r) as Stored }); } catch { db.prepare("DELETE FROM memory_dreaming_sources WHERE scope_key=? AND input_digest=? AND intake_epoch=?").run(row.k, row.d, row.e); }
  }
  return out;
}

function finishBatch(db: ReturnType<typeof getMemoryDb>, scopeKey: string, inputDigest: string, epoch: number, episodeIds: readonly string[]): void {
  db.transaction(() => {
    markGathered(db, episodeIds, Date.now());
    db.prepare("DELETE FROM memory_dreaming_sources WHERE scope_key=? AND input_digest=? AND intake_epoch=?").run(scopeKey, inputDigest, epoch);
  }).immediate();
}

/**
 * The turns of a stored answer: every ticket from `applied` on is applied (one at a time, the count saved after each so a kill never repeats more than the ticket that was running), then the batch ends.
 * `built` is rebuilt from the stored episode ids when this is a resume (the packet the model saw is not stored; the maps a ticket is checked against are rebuilt from the same records).
 */
function applyStored(db: ReturnType<typeof getMemoryDb>, key: string, inputDigest: string, stored: Stored, built: BuiltPacket, batch: Batch, deps: GatherDeps, counts: GatherCounts): void {
  const save = (applied: number) => db.prepare("UPDATE memory_dreaming_sources SET result_json=?, lease_expires_at=? WHERE scope_key=? AND input_digest=? AND intake_epoch=?")
    .run(JSON.stringify({ ...stored, applied, counts }), new Date(Date.now() + APPLY_LEASE_MS).toISOString(), key, inputDigest, stored.epoch);
  const answer = stored.answer.slice(0, gv().maxTicketsPerAnswer);
  counts.dropped += Math.max(0, stored.answer.length - answer.length);
  for (let index = Math.max(0, stored.applied); index < answer.length; index += 1) {
    applyTicket(answer[index], built, batch, counts, deps.assertCustody);
    save(index + 1);
    if (index + 1 === Math.ceil(answer.length / 2) && answer.length > 1) deps.at?.("applied-half");
  }
}

/** Rebuilds the batch of a stored answer from its turn records (the same rows, the same numbering: oldest first). Null when none of them is left to speak. */
function rebuild(db: ReturnType<typeof getMemoryDb>, stored: Stored): { batch: Batch; built: BuiltPacket } | null {
  const rows = stored.episodes.length ? db.prepare(`SELECT e.rowid AS rid, e.episode_id AS episodeId, e.ticket_id AS ticketId, (SELECT t.run_id FROM memory_tickets t WHERE t.ticket_id = e.ticket_id) AS runId, e.agent_id AS agentId, e.chat_id AS chatId, e.project_id AS projectId,
      e.project_path_hash AS projectHash, e.summary AS summary, e.detail_json AS detail, e.created_at AS createdAt FROM memory_episodes e WHERE e.episode_id IN (${stored.episodes.map(() => "?").join(",")}) ORDER BY e.created_at, e.rowid`)
    .all(...stored.episodes) as Array<Omit<PendingRow, "detail" | "summary"> & { detail: string | null; summary: string | null }> : [];
  const live = rows.filter(row => row.summary).map(row => ({ ...row, summary: row.summary as string, detail: parseFacts(row.detail) }));
  if (!live.length) return null;
  adoptKnownProjects(live);
  const batch: Batch = { groupKey: "resume", actorId: live[0].agentId, personal: live[0].detail.pers === 1, rows: live };
  const built = buildPacket(batch);
  return built ? { batch, built } : null;
}

/**
 * One pass of the gathering. Never throws for a model that is missing or answers badly (that is `skippedNoModel` / `failure`); throws only what the caller's custody fence throws (the owner changed memory: the caller yields).
 * `more`: turn records are still waiting after this pass (the caller spaces the next pass).
 */
export async function runGatheringPass(deps: GatherDeps): Promise<GatherOutcome> {
  const counts = emptyCounts();
  const outcome: GatherOutcome = { calls: 0, batches: 0, counts, skippedNoModel: false, more: false, blocked: [] };
  if (!gatheringEnabled()) return outcome;
  const db = getMemoryDb();
  const store = getMemoryStoreInfo();
  const since = sinceInstant(db, deps.since);
  ensureSourcesTable(db);
  sweepForgottenFacts(db);
  const system = gatheringSystemPrompt();
  if (!system) return outcome;
  // First: what an earlier pass left half done.
  for (const open of resumeAnswered(db, store.revocationEpoch)) {
    if (deps.stopped()) { outcome.more = true; return outcome; }
    const restored = rebuild(db, open.stored);
    if (!restored) { finishBatch(db, open.key, open.digest, open.stored.epoch, open.stored.episodes); continue; }
    const lease = newLease();
    if (claimRow(db, open.key, open.digest, open.stored.epoch, lease, APPLY_LEASE_MS) !== "ok") { outcome.more = true; continue; }
    // The row now reads 'processing' again; the stored answer is put back with the lease taken.
    db.prepare("UPDATE memory_dreaming_sources SET state='answered', result_json=? WHERE scope_key=? AND input_digest=? AND intake_epoch=?").run(JSON.stringify(open.stored), open.key, open.digest, open.stored.epoch);
    Object.assign(counts, open.stored.counts ?? {});
    applyStored(db, open.key, open.digest, open.stored, restored.built, restored.batch, deps, counts);
    finishBatch(db, open.key, open.digest, open.stored.epoch, open.stored.episodes);
    outcome.batches += 1;
  }
  const setAside = new Set<string>();
  const values = gv();
  while (outcome.calls < values.maxCallsPerPass) {
    if (deps.stopped()) { outcome.more = true; return outcome; }
    const { batch, skipped } = nextBatch(db, since, setAside);
    if (skipped.length) markGathered(db, skipped, Date.now());
    if (!batch) break;
    // A store this batch needs cannot be read: set it aside (its turn records stay as they are) and go on with the next agent's batch.
    const unreadable = unreadableStoresOf(batch);
    if (unreadable.length) { setAside.add(batch.groupKey); outcome.blocked.push({ stores: unreadable, turns: batch.rows.length }); outcome.more = true; continue; }
    const built = buildPacket(batch);
    if (!built) { markGathered(db, batch.rows.map(row => row.episodeId), Date.now()); continue; }
    if (!deps.call) { outcome.skippedNoModel = true; outcome.more = true; return outcome; }
    const episodeIds = built.included.map(row => row.episodeId);
    const key = `${SCOPE_PREFIX}${digest([store.ownerNamespace, batch.groupKey])}`, inputDigest = digest(episodeIds), lease = newLease();
    deps.assertCustody();
    try {
      const bad = JSON.parse(getMeta(BAD_ANSWER_KEY) || "null") as { digest?: string; at?: number } | null;
      if (bad?.digest === inputDigest && typeof bad.at === "number" && Date.now() - bad.at < values.unreadableAnswerWaitMs) { outcome.failure = { code: "gather_recent_unreadable_answer" }; outcome.more = true; return outcome; }
    } catch { /* no record: ask */ }
    const claim = claimRow(db, key, inputDigest, store.revocationEpoch, lease, 330_000, episodeIds);
    if (claim === "stale") continue;
    if (claim === "held") { outcome.more = true; return outcome; }
    deps.at?.("read");
    let text: string | null = null, failed = false;
    try {
      outcome.calls += 1;
      const result = await deps.call({ systemPrompt: system, input: built.json, accept: (value) => parseGatherAnswer(value) !== null });
      text = result.text; failed = result.text === null;
    } catch { failed = true; }
    const answer = failed ? null : parseGatherAnswer(text);
    if (!answer) {
      // No answer, or one that cannot be read: the turn records stay as they are, the row is let go, and the next signal asks again.
      db.prepare("UPDATE memory_dreaming_sources SET state='retry', lease_token=NULL, lease_expires_at=NULL WHERE scope_key=? AND input_digest=? AND intake_epoch=?").run(key, inputDigest, store.revocationEpoch);
      outcome.failure = { code: failed ? "gather_model_unavailable" : "gather_result_invalid" }; outcome.more = true;
      if (!failed) { try { setMeta(BAD_ANSWER_KEY, JSON.stringify({ digest: inputDigest, at: Date.now() })); } catch { /* the pile is asked again next time */ } }
      return outcome;
    }
    deps.assertCustody();
    const stored: Stored = { answer, episodes: episodeIds, applied: 0, counts: emptyCounts(), epoch: store.revocationEpoch };
    db.prepare("UPDATE memory_dreaming_sources SET state='answered', result_json=?, lease_expires_at=?, completed_at=? WHERE scope_key=? AND input_digest=? AND intake_epoch=?")
      .run(JSON.stringify(stored), new Date(Date.now() + APPLY_LEASE_MS).toISOString(), new Date().toISOString(), key, inputDigest, store.revocationEpoch);
    deps.at?.("answer");
    applyStored(db, key, inputDigest, stored, built, batch, deps, counts);
    finishBatch(db, key, inputDigest, store.revocationEpoch, episodeIds);
    outcome.batches += 1;
  }
  outcome.more = outcome.blocked.length > 0 || (gatherDueAt(gatherDueState({ since }), Date.now()) !== null && outcome.calls >= values.maxCallsPerPass);
  return outcome;
}

// ── the old resting-time window writes through the same door (K3'-2a, change 2) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** One rule the window's judgment (dreaming.ts: "merge redundant or fragmentary lines of one agent into a few durable rules") produced: its text, its kind and the numbers of the window's lines it replaces. */
export interface ConsolidationRule { text: string; kind?: string; absorbed?: number[] }
export interface ConsolidationApplied { rules: number; written: number; merged: number; refused: number; writtenIds: string[]; writtenLines: Array<{ id: string; kind: string; text: string }>; absorbedIds: string[]; refusals: string[] }

/**
 * The window's rules are received like any other ticket and written by the one write door (ticket-receiver.ts + ticket-call.ts applyTicketReceipt), instead of `insertMemoryEntry` + `supersedeMemoryEntries` directly:
 * the secret check, the line length, the owner and kind rules, the duplicate and ceiling checks, the two host columns (origin `inferred`, certainty `unverified`: the model's own consolidation), the right store (an
 * agent's folder store with the layout switch on) and the replacement of the old lines (several lines -> one: `condense` of up to 8 shown lines; one -> `rewrite`; none -> `add`) are the door's.
 * The lines a rule names are the lines the window's judgment was shown (numbers -> `shownLineOf`), by the same ids a model names them by. A rule that names more than 8 lines replaces the first 8: the rest stay and the next
 * window (its digest has changed) sees them again. Nothing here reads a word of a line.
 */
export function applyConsolidationRules(input: { agentId: string; entries: readonly MemoryEntry[]; rules: readonly ConsolidationRule[]; passAbsorbed: readonly number[];
  evidenceFor(own: readonly MemoryEntry[]): readonly string[]; assertCustody(): void }): ConsolidationApplied {
  const result: ConsolidationApplied = { rules: input.rules.length, written: 0, merged: 0, refused: 0, writtenIds: [], writtenLines: [], absorbedIds: [], refusals: [] };
  const actor = memoryActorKind(input.agentId);
  // A hub-called agent keeps no memory of the owner's; nothing is written for it.
  if (actor === "hub") { result.refused = input.rules.length; result.refusals.push("hub_agent"); return result; }
  const shown = new Map<number, ShownLine>();
  input.entries.forEach((entry, index) => { const line = ticketCall().shownLineOf(entry.id); if (line) shown.set(index + 1, line); });
  const visible = [...new Map([...shown.values()].map(line => [line.id, line])).values()];
  const conversation: TicketHostFacts["conversation"] = actor === "folderAgent" || actor === "special" ? "folder_agent" : "work_session";
  for (const rule of input.rules) {
    input.assertCustody();
    const numbers = [...new Set(rule.absorbed?.length ? rule.absorbed : input.passAbsorbed)];
    const lines = [...new Map(numbers.map(number => shown.get(number)).filter((line): line is ShownLine => Boolean(line)).map(line => [line.id, line])).values()].slice(0, 8);
    const own = lines.map(line => input.entries.find(entry => entry.id === line.memoryId)).filter((entry): entry is MemoryEntry => Boolean(entry));
    const ticket = { action: lines.length >= 2 ? "condense" : lines.length === 1 ? "rewrite" : "add", ...(lines.length ? { targets: lines.map(line => line.id) } : {}),
      scope: "agent_repo", kind: rule.kind ?? "procedure", text: rule.text.trim(), source: "inferred" };
    const host: TicketHostFacts = { conversation, turn_source: "unknown", project_bound: false, owner_text: null, outside_text: false, tools_ran: false, receipt: false, visible };
    const receipt = receiveTickets({ tickets: [ticket] }, host);
    if (!receipt || !receipt.items.length) { result.refused += 1; result.refusals.push("tickets_unavailable"); continue; }
    const context: CurationContext = { turnId: null, projectPath: null, projectId: null, agentId: input.agentId, chatId: null, ownerSpoke: false, turnFacts: { toolsRan: false, inputsRead: false } };
    let applied: ReturnType<ReturnType<typeof ticketCall>["applyTicketReceipt"]>;
    try { applied = ticketCall().applyTicketReceipt({ receipt, context, ownerText: undefined, roomContent: false, visible, evidenceRefs: [...input.evidenceFor(own)] }); }
    catch (error) { if (machineCodeOf(error) === "memory_source_custody_changed") throw error; result.refused += 1; result.refusals.push("apply_failed"); continue; }
    const answer = applied.answers[0];
    if (!answer || answer.status !== "ok") { result.refused += 1; result.refusals.push(answer?.why ?? answer?.status ?? "no_answer"); continue; }
    if (answer.result === "merged") { result.merged += 1; continue; }
    result.written += 1;
    const newId = applied.writtenIds[0];
    if (newId) { result.writtenIds.push(newId); const line = ticketCall().shownLineOf(newId); if (line) result.writtenLines.push({ id: newId, kind: line.kind, text: String(line.text ?? "") }); }
    if (newId && (answer.result === "condensed" || answer.result === "rewritten")) for (const entry of own) result.absorbedIds.push(entry.id);
  }
  return result;
}
const machineCodeOf = (error: unknown): string | null => { const code = (error as { code?: unknown } | null)?.code; return typeof code === "string" ? code : error instanceof Error ? error.message : null; };

/** Tests only. */
export const __gatheringForTests = { buildPacket, nextBatch, readPending, PENDING_WHERE, looksSecret, autoLocalEmbedding };
