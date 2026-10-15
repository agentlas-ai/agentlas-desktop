import type { RawMemoryEvent } from "../memory/events";
import type { AgentlasAskQuestion } from "../../shared/ask-fence-flatten";

/*
 * Memory notes a model recorded through the agentlas-turn `memory_note` tool during one run. They wait here until the
 * turn's curation drains them (mcp/client.ts) and are then handed to the same curator the parsed `## Memory Events`
 * envelope feeds. Process-local on purpose: the run, the tool's control server and the curation all live in the host
 * process that built the run's MCP config. No electron import (the daemon loads this).
 */
const MAX_NOTES_PER_RUN = 8;
const MAX_RUNS = 64;
const TTL_MS = 6 * 60 * 60 * 1000;
const pending = new Map<string, { at: number; events: RawMemoryEvent[] }>();

export function turnNotesKey(chatId: string, runId: string): string {
  return `${chatId}|${runId}`;
}

function prune(now: number): void {
  for (const [key, entry] of pending) if (now - entry.at > TTL_MS) pending.delete(key);
  while (pending.size > MAX_RUNS) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

/** Returns the 1-based slot of the note, or null when this run already has the maximum. */
export function recordTurnMemoryNote(key: string, event: RawMemoryEvent): number | null {
  const now = Date.now();
  prune(now);
  const entry = pending.get(key) ?? { at: now, events: [] };
  if (entry.events.length >= MAX_NOTES_PER_RUN) return null;
  entry.events.push(event);
  pending.set(key, entry);
  return entry.events.length;
}

/** Removes and returns the run's notes (empty when none). */
export function takeTurnMemoryNotes(key: string | null | undefined): RawMemoryEvent[] {
  if (!key) return [];
  const entry = pending.get(key);
  pending.delete(key);
  return entry ? entry.events : [];
}

export const TURN_MEMORY_NOTE_LIMIT = MAX_NOTES_PER_RUN;

/*
 * Choice cards a model recorded through the agentlas-turn `ask_form` tool. Drained per pass (mcp/client.ts) and
 * re-entered as canonical <<agentlas-ask>> blocks, so every parser/renderer downstream is unchanged.
 */
const MAX_ASKS_PER_RUN = 8;
const pendingAsks = new Map<string, { at: number; asks: AgentlasAskQuestion[] }>();

/** Returns false when this run already holds the maximum. */
export function recordTurnAsk(key: string, asks: AgentlasAskQuestion[]): boolean {
  const now = Date.now();
  for (const [k, entry] of pendingAsks) if (now - entry.at > TTL_MS) pendingAsks.delete(k);
  while (pendingAsks.size > MAX_RUNS) {
    const oldest = pendingAsks.keys().next().value;
    if (oldest === undefined) break;
    pendingAsks.delete(oldest);
  }
  const entry = pendingAsks.get(key) ?? { at: now, asks: [] };
  if (entry.asks.length + asks.length > MAX_ASKS_PER_RUN) return false;
  entry.asks.push(...asks);
  pendingAsks.set(key, entry);
  return true;
}

/** Removes and returns the run's recorded questions (empty when none). */
export function takeTurnAsks(key: string | null | undefined): AgentlasAskQuestion[] {
  if (!key) return [];
  const entry = pendingAsks.get(key);
  pendingAsks.delete(key);
  return entry ? entry.asks : [];
}

export const TURN_ASK_LIMIT = MAX_ASKS_PER_RUN;
