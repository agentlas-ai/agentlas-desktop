// The host half of the memory_search and memory_get tools (Agentlas 2.0 K4b, / S 3.5, decision). READ ONLY.
//
// Same names, arguments and answer shape as the engine's memory.search / memory.get (agentlas_cloud/memory_recall.py), with ONE difference by design: the model names no scope. A call reads exactly the lines the run's own recall read
// (turn-tools/memory-facts.ts TurnReadScope, registered by buildMemoryContext): the reader's agent, project, conversation and domain, the guest and Personal facts - through the same store function (`listMemoryForContext`) and the same
// recall policy. The engine's `scope` and `projectDir` arguments are therefore not offered; a call that sends them is answered and the answer says they were ignored (a format never stops a call,).
//   - the personal agent's own conversation reads Personal lines; a folder agent reads only its own agent memory; a borrowed or guest node reads none of the owner's (the recall policy decides, this file adds no rule of its own);
//   - a run whose recall never read (a read boundary, a front turn, an app run, a team node that names no run) has no scope: the answer is `unavailable` with the reason `not_here`, never an empty list that looks like "nothing remembered".
// The formula, the candidate test and the tie order are the turn-start recall's (context.ts rankMemoryCandidates). A line the call shows is added to the run's shown lines, so the model can name it in a memory_ticket `targets`.
// Nothing here reads a word of the question to decide anything and no model is called.
import { memoryBlockKey } from "./graph";
import { listMemoryForContext, withSubStoreReadProbe, type MemoryEntry } from "./store";
import { nativeRecallFor } from "./native-text";
import { rankHybridLocal, localEmbeddingTokens } from "./local-embedding";
import { rankMemoryCandidates, readableEpisodes, recallFrameFor } from "./context";
import { recallQueryOf, recallReasonOfError, recallStatusLine, type RecallReadReason } from "./recall-contract";
import { rememberShownMemory, turnReadScope, type TurnReadScope } from "../turn-tools/memory-facts";

export interface MemoryReadCallInput { chatId: string; runId: string; args: unknown }

// The engine tool's numbers, carried over so the same call gives the same size on every surface (agentlas_cloud/memory_recall.py: limit default 8 and at most 30, RECENT_LIMIT 5, TEXT_LIMIT 600 = the longest line the store takes).
// Basis: none measured on the desktop ("decided value - no basis"). Reached: more than 30 lines or 5 turn records are never returned in one call (the model narrows with `since`/`until`/`kinds` or asks again); a line longer than 600
// characters cannot exist; a turn record longer than 600 is cut in the list and whole in memory_get.
export const MEMORY_SEARCH_DEFAULT_LIMIT = 8;
export const MEMORY_SEARCH_MAX_LIMIT = 30;
export const MEMORY_SEARCH_RECENT_LIMIT = 5;
export const MEMORY_TEXT_LIMIT = 600;
const KNOWN_SEARCH_ARGS = new Set(["query", "since", "until", "types", "kinds", "limit"]);
const DAY_MS = 86_400_000;

type Answer = Record<string, unknown>;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const unavailable = (reason: RecallReadReason): Answer => ({ status: "unavailable", reason, memory: recallStatusLine("unavailable", reason) });
const keyOf = (chatId: string, runId: string): string => `${chatId}|${runId}`;

/**
 * The lines this run's recall could read (the same scope object the store function takes), or why they cannot be read. `partial` (K3'-2b): a store of the agent or project that could not be opened (after the one more wait for a
 * lock) - the lines of the others are returned, and the answer says so in the engine's closed words, so a line that is not there is not taken for a line that does not exist.
 */
function readLines(scope: TurnReadScope): { entries: MemoryEntry[]; partial: Exclude<RecallReadReason, "not_here"> | null } | { reason: RecallReadReason } {
  try {
    const read = withSubStoreReadProbe({ agentId: scope.agentId, projectPath: scope.projectPath, projectId: scope.projectId, chatId: scope.chatId },
      () => listMemoryForContext({ projectId: scope.projectId, projectPath: scope.projectPath, agentId: scope.agentId, chatId: scope.chatId,
        visibilityDomain: scope.visibilityDomain ?? null, ...(scope.guest !== undefined ? { guest: scope.guest } : {}), ...(scope.personalRead !== undefined ? { personalRead: scope.personalRead } : {}) }, -1));
    return { entries: read.value, partial: read.unread };
  } catch (error) { return { reason: recallReasonOfError(error) }; }
}
const partialNote = (reason: RecallReadReason | null): Answer => (reason && reason !== "not_here" ? { memory: recallStatusLine("partial", reason, "lines") } : {});

const shownKind = (entry: MemoryEntry): string => entry.requestContext?.ticket_kind ?? entry.kind;
const ageDays = (createdAt: string | null | undefined): number | null => {
  const then = Date.parse(String(createdAt ?? ""));
  return Number.isFinite(then) ? Math.max(0, Math.floor((Date.now() - then) / DAY_MS)) : null;
};
const clip = (text: string, limit = MEMORY_TEXT_LIMIT): string => { const chars = [...text]; return chars.length > limit ? chars.slice(0, limit).join("") : text; };
const oneLine = (text: string): string => clip(text).split(/\s+/).filter(Boolean).join(" ");

function lineItem(entry: MemoryEntry, native: string | undefined, score?: { lexical: number; vector: number; total: number }): Answer {
  const id = memoryBlockKey(entry.content);
  return {
    id, type: "memory", kind: shownKind(entry), text: clip(entry.content), createdAt: entry.createdAt, ageDays: ageDays(entry.createdAt), source: "agentlas-memory", line: `[${id} · ${shownKind(entry)}] ${oneLine(entry.content)}`,
    ...(native ? { textNative: clip(native) } : {}), scope: entry.scope,
    ...(score ? { score: { lexical: Math.round(score.lexical * 1000) / 1000, vector: Math.round(score.vector * 1000) / 1000, total: Math.round(score.total * 1000) / 1000 } } : {}),
  };
}

type Episode = ReturnType<typeof readableEpisodes>[number];
function episodeItem(episode: Episode, score?: { lexical: number; vector: number; total: number }): Answer {
  const id = `e:${episode.id}`;
  return {
    id, type: "episode", kind: "episode", text: clip(episode.summary), createdAt: episode.createdAt, ageDays: ageDays(episode.createdAt), source: "agentlas-memory", line: `[${id} · episode] ${oneLine(episode.summary)}`,
    ...(score ? { score: { lexical: Math.round(score.lexical * 1000) / 1000, vector: Math.round(score.vector * 1000) / 1000, total: Math.round(score.total * 1000) / 1000 } } : {}),
  };
}

/** `since` / `until`: an ISO date or time; null when absent. A value that is not a date is answered `time_invalid` (with its name), never ignored. */
function timeBound(value: unknown): { at: number | null } | { bad: true } {
  if (value === undefined || value === null || value === "") return { at: null };
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? { at } : { bad: true };
}

/** memory_search. Never throws for the model's input: a bad argument is answered with its name and its limits, a store that cannot be read is answered with the engine's closed words. */
export async function receiveMemorySearchCall(input: MemoryReadCallInput): Promise<Answer> {
  const key = keyOf(input.chatId, input.runId);
  const args: Record<string, unknown> = isObject(input.args) ? input.args : {};
  const scope = turnReadScope(key);
  if (!scope) return unavailable("not_here");
  const rawQuery = typeof args.query === "string" ? args.query : "";
  // A long query is not refused (the engine refuses over 2,000 characters; says make it work): it keeps its first and last 1,000 characters, the same cut the turn-start recall makes.
  const query = recallQueryOf(rawQuery);
  if (!query || localEmbeddingTokens(query).length === 0) return { status: "invalid", why: "query_missing", min: 1, max: 2000, note: "send a few words to look for" };
  const since = timeBound(args.since), until = timeBound(args.until);
  if ("bad" in since) return { status: "invalid", why: "time_invalid", field: "since", note: "an ISO date such as 2026-11-01" };
  if ("bad" in until) return { status: "invalid", why: "time_invalid", field: "until", note: "an ISO date such as 2026-11-30" };
  const types = new Set<string>(Array.isArray(args.types) ? args.types.filter((value): value is string => value === "memory" || value === "episode") : []);
  if (!types.size) { types.add("memory"); types.add("episode"); }
  const kinds = new Set<string>(Array.isArray(args.kinds) ? args.kinds.filter((value): value is string => typeof value === "string").slice(0, 8) : []);
  const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.min(MEMORY_SEARCH_MAX_LIMIT, Math.max(1, args.limit)) : MEMORY_SEARCH_DEFAULT_LIMIT;
  const ignored = Object.keys(args).filter((name) => !KNOWN_SEARCH_ARGS.has(name));
  const inRange = (createdAt: string): boolean => {
    const at = Date.parse(createdAt);
    if (!Number.isFinite(at)) return since.at === null && until.at === null;
    return (since.at === null || at >= since.at) && (until.at === null || at <= until.at);
  };

  let items: Answer[] = [];
  let recent: Answer[] = [];
  let searched = 0;
  let partial: Exclude<RecallReadReason, "not_here"> | null = null;
  const shown: string[] = [];
  try {
    if (types.has("memory")) {
      const read = readLines(scope);
      if ("reason" in read) return unavailable(read.reason);
      partial = read.partial;
      const pool = read.entries.filter((entry) => inRange(entry.createdAt) && (!kinds.size || kinds.has(shownKind(entry)) || kinds.has(entry.kind)));
      searched += pool.length;
      const ranked = rankMemoryCandidates(pool, query, recallFrameFor(pool, scope.chatId)).slice(0, limit);
      const natives = nativeRecallFor("memory_entry", ranked.map((row) => row.entry.id));
      items = ranked.map((row) => lineItem(row.entry, natives.get(row.entry.id)?.text, { lexical: row.lexical, vector: row.vector, total: row.score }));
      shown.push(...ranked.map((row) => row.entry.id));
    }
    if (types.has("episode")) {
      const episodes = readableEpisodes(scope.projectId, scope.projectPath, { agentId: scope.agentId, chatId: scope.chatId }).filter((episode) => inRange(episode.createdAt));
      searched += episodes.length;
      const natives = nativeRecallFor("memory_episode", episodes.map((episode) => episode.id));
      recent = rankHybridLocal(query, episodes.map((episode) => ({
        id: episode.id, text: episode.summary, embedding: episode.embedding.vector, createdAt: episode.createdAt, tier: 4, episode,
        ...(natives.has(episode.id) ? { altText: natives.get(episode.id)!.text, altEmbedding: natives.get(episode.id)!.vector } : {}),
      }))).filter((row) => row.lexicalScore > 0 || row.semanticEligible).slice(0, MEMORY_SEARCH_RECENT_LIMIT)
        .map((row) => episodeItem(row.item.episode, { lexical: row.lexicalScore, vector: row.vectorScore, total: row.score }));
    }
  } catch (error) { return unavailable(recallReasonOfError(error)); }
  // The lines this call showed can be named in a memory_ticket's `targets` (the same rule as the lines the turn-start recall showed).
  try { rememberShownMemory(key, shown); } catch { /* observability of the shown lines never blocks a read */ }
  return { status: "ok", query, scope: "this_conversation", items, recent, coverage: { searched }, ...partialNote(partial), ...(ignored.length ? { ignored } : {}) };
}

const LINE_ID = /^(?:m:)?(h:[0-9a-f]{16}|[0-9a-f]{16})$/;
const EPISODE_ID = /^e:([A-Za-z0-9._:-]{1,200})$/;

/** memory_get: one line (by the id in front of it, `h:...`) or one turn record (`e:...`) the run's recall could read, in full. Not readable or not there: `not_found`. */
export async function receiveMemoryGetCall(input: MemoryReadCallInput): Promise<Answer> {
  const key = keyOf(input.chatId, input.runId);
  const args: Record<string, unknown> = isObject(input.args) ? input.args : {};
  const scope = turnReadScope(key);
  if (!scope) return unavailable("not_here");
  const id = typeof args.id === "string" ? args.id.trim() : "";
  const episodeId = EPISODE_ID.exec(id)?.[1] ?? null;
  const lineMatch = LINE_ID.exec(id);
  if (!episodeId && !lineMatch) return { status: "invalid", why: "id_invalid", note: "the id in front of a line: h:<16 hex>, or e:<id> for a turn record" };
  const ignored = Object.keys(args).filter((name) => name !== "id");
  try {
    if (episodeId) {
      const episode = readableEpisodes(scope.projectId, scope.projectPath, { agentId: scope.agentId, chatId: scope.chatId }).find((candidate) => candidate.id === episodeId);
      if (!episode) return { status: "not_found", id };
      return { status: "ok", item: { ...episodeItem(episode), text: episode.summary }, ...(ignored.length ? { ignored } : {}) };
    }
    const wanted = lineMatch![1].startsWith("h:") ? lineMatch![1] : `h:${lineMatch![1]}`;
    const read = readLines(scope);
    if ("reason" in read) return unavailable(read.reason);
    const entry = read.entries.find((candidate) => memoryBlockKey(candidate.content) === wanted);
    if (!entry) return { status: "not_found", id: wanted, ...partialNote(read.partial) };
    try { rememberShownMemory(key, [entry.id]); } catch { /* see above */ }
    const native = nativeRecallFor("memory_entry", [entry.id]).get(entry.id)?.text;
    return { status: "ok", item: { ...lineItem(entry, native), text: entry.content, ...(native ? { textNative: native } : {}),
      origin: { class: entry.originClass ?? null, certainty: entry.certainty ?? null } }, ...(ignored.length ? { ignored } : {}) };
  } catch (error) { return unavailable(recallReasonOfError(error)); }
}
