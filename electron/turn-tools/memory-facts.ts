import type { CurationContext } from "../memory/curator";

/*
 * What the memory_ticket tool needs to know about the run it is called in, and what the run's recall showed the model (Agentlas 2.0 K2b').
 *
 * The tool writes NOW (the answer of a ticket is a fact: "saved" means the line is stored), so the host facts that used to be read at the turn's end
 * (who wrote the turn, which project, whether a tool ran) are read at the call. They live in the run's own function (mcp/client.ts), which registers a
 * reader here when the turn starts and removes it when the turn ends. Process-local on purpose, like notes.ts: the run, the tool's control server and the
 * recall all live in the host process that built the run's MCP config. No electron import (the daemon loads this).
 *
 * Nothing here is read from a model: the reader is the host's, the shown ids are what recall put into the prompt.
 */
export interface TurnMemoryFacts {
  /** The curation context of this turn as of now (ownerSpoke and turnFacts are read when asked, not frozen). */
  curation: () => CurationContext;
  /** The owner's own words of this turn (null: the prompt was written by the host). */
  ownerText: () => string | null;
  /** A tool other than memory_ticket has completed in this turn. */
  otherToolsRan: () => boolean;
  /** A file, attachment, photo or room text entered the turn besides the owner's message. */
  inputsRead: () => boolean;
  /** The turn may not write memory (a read-only boundary, a companion front turn). */
  readOnly: () => boolean;
  /** The personal agent read what a group room said during this turn (a room is not the secretary's memory, O5): only a line that rests on the owner's own words is written. */
  roomContent?: () => boolean;
}

/**
 * K4b: what this run's recall READ (the same scope object it passed to the store: the reader's agent, project, conversation, domain, guest and Personal facts). The memory_search and memory_get tools read with exactly this and nothing wider,
 * so a tool can never show a line the turn's own recall could not (the model names no scope: the tool has no scope argument). A run whose recall never ran (a read boundary, a front turn, an app run) has none: the tools read nothing.
 */
export interface TurnReadScope {
  projectId: string | null;
  projectPath: string | null;
  agentId: string | null;
  chatId: string | null;
  visibilityDomain?: string | null;
  guest?: boolean;
  personalRead?: boolean;
}

interface Counts { written: number; deduped: number; redacted: number; sessionOnly: number; discarded: number }
interface Entry { at: number; facts: TurnMemoryFacts | null; readScope: TurnReadScope | null; shown: Set<string>; tickets: number; calls: number; counts: Counts; writtenIds: string[]; refused: Map<string, string> }

const MAX_RUNS = 64;
const MAX_SHOWN = 400;
const TTL_MS = 6 * 60 * 60 * 1000;
const runs = new Map<string, Entry>();

function prune(now: number): void {
  for (const [key, entry] of runs) if (now - entry.at > TTL_MS) runs.delete(key);
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next().value;
    if (oldest === undefined) break;
    runs.delete(oldest);
  }
}

function entryFor(key: string): Entry {
  const now = Date.now();
  prune(now);
  const existing = runs.get(key);
  if (existing) { existing.at = now; return existing; }
  const created: Entry = { at: now, facts: null, readScope: null, shown: new Set(), tickets: 0, calls: 0, counts: { written: 0, deduped: 0, redacted: 0, sessionOnly: 0, discarded: 0 }, writtenIds: [], refused: new Map() };
  runs.set(key, created);
  return created;
}

/** The run starts (or its facts change owner): the reader the tool will ask. */
export function registerTurnMemoryFacts(key: string, facts: TurnMemoryFacts): void {
  entryFor(key).facts = facts;
}

export function turnMemoryFacts(key: string): TurnMemoryFacts | null {
  return runs.get(key)?.facts ?? null;
}

/** The run's recall starts: the scope it reads with (set again when a recall falls back to the global scope). Process-local like the facts; dropped with them when the turn ends. */
export function registerTurnReadScope(key: string, scope: TurnReadScope): void {
  entryFor(key).readScope = { ...scope };
}

/** The scope the run's recall read with, or null when no recall of this run ever read (the memory tools then read nothing). */
export function turnReadScope(key: string): TurnReadScope | null {
  const scope = runs.get(key)?.readScope;
  return scope ? { ...scope } : null;
}

/** Recall put these memory rows (store ids) into the prompt of the run. Union over the run's recalls; bounded. */
export function rememberShownMemory(key: string, memoryIds: Iterable<string>): void {
  const entry = entryFor(key);
  for (const id of memoryIds) {
    if (entry.shown.size >= MAX_SHOWN) break;
    entry.shown.add(id);
  }
}

export function shownMemoryIds(key: string): string[] {
  return [...(runs.get(key)?.shown ?? [])];
}

/** One ticket was received in this run's tool call (count of tickets, not calls). */
export function noteTurnTickets(key: string, count: number): number {
  const entry = entryFor(key);
  entry.tickets += Math.max(0, Math.floor(count));
  return entry.tickets;
}

/** One memory_ticket call of the run has been answered (calls, not tickets): the run's tool count minus these is the number of OTHER tools that ran. */
export function noteTurnMemoryCall(key: string): void { entryFor(key).calls += 1; }
export function turnMemoryCalls(key: string): number { return runs.get(key)?.calls ?? 0; }

/** a ticket the host refused is remembered for the rest of the turn (signature -> the refusal word), so the same ticket refused for the same reason is answered closed the second time and the model does not write it again and again. Bounded (16 per turn), dropped with the turn. */
export function turnRefusedBefore(key: string, signature: string, why: string | null | undefined): boolean {
  return Boolean(why) && runs.get(key)?.refused.get(signature) === why;
}
export function noteTurnRefused(key: string, signature: string, why: string | null | undefined): void {
  if (!why) return;
  const entry = entryFor(key);
  if (entry.refused.size < 16) entry.refused.set(signature, why);
}

/** What the run's calls did, added up for the turn's own record (the lines were written at the call; the turn's ticket counts them and links them). */
export function addTurnToolWrites(key: string, counts: Partial<Counts>, writtenIds: readonly string[]): void {
  const entry = entryFor(key);
  for (const name of ["written", "deduped", "redacted", "sessionOnly", "discarded"] as const) entry.counts[name] += Math.max(0, Math.floor(counts[name] ?? 0));
  for (const id of writtenIds) if (entry.writtenIds.length < 200) entry.writtenIds.push(id);
}

/** The turn ends: the reader and the shown ids are dropped; what the model's tickets did is returned (tickets 0 = the model sent none). */
export function endTurnMemoryFacts(key: string | null | undefined): { tickets: number; counts: Counts; writtenIds: string[] } {
  const empty = { tickets: 0, counts: { written: 0, deduped: 0, redacted: 0, sessionOnly: 0, discarded: 0 }, writtenIds: [] as string[] };
  if (!key) return empty;
  const entry = runs.get(key);
  runs.delete(key);
  return entry ? { tickets: entry.tickets, counts: entry.counts, writtenIds: entry.writtenIds } : empty;
}

/** The turn's record of what its tickets did, in the shape curateReply takes (undefined when the model sent no ticket: the turn is recorded exactly as before). */
export function toolWritesOf(ended: { tickets: number; counts: { written: number; deduped: number; redacted: number; sessionOnly: number; discarded: number }; writtenIds: string[] }):
  { candidates: number; report: { written: number; deduped: number; redacted: number; sessionOnly: number; discarded: number }; writtenIds: string[] } | undefined {
  return ended.tickets > 0 ? { candidates: ended.tickets, report: { ...ended.counts }, writtenIds: [...ended.writtenIds] } : undefined;
}
