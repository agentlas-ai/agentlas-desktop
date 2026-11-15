import type { AgentlasAskQuestion } from "../../shared/ask-fence-flatten";

/*
 * Per-run notes of the agentlas-turn tools that wait for the turn's end. The memory notes that used to wait here are gone (K2b': memory_ticket writes at the call, see memory-facts.ts);
 * what is left are the choice cards of ask_form. Process-local on purpose: the run, the tool's control server and the drain all live in the host process that built the run's MCP config.
 * No electron import (the daemon loads this).
 */
const MAX_RUNS = 64;
const TTL_MS = 6 * 60 * 60 * 1000;

export function turnNotesKey(chatId: string, runId: string): string {
  return `${chatId}|${runId}`;
}

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
