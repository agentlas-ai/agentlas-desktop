// "Which skills were made from this line", for the memory LIST, before the owner forgets it (Agentlas 2.0 redesign backend C). The forget answer already says it afterwards
// (`derivedSkills` of the mutation result, owner-mutations.ts `derivedSkillsOf`); both ask the same question of the same place: `appliedSkillSources` in agents/workspace-service.ts
// decides what counts as "a skill made from these lessons". Nothing here is stored and nothing is written: one pass over the agents' applied skill promotions per list, then
// one lookup per line over what that pass found, so a list of 500 lines costs one pass, not 500.
//
// Which lessons a forget would blank is decided inside `revokeOneMemoryEntry` (revocations.ts), in a transaction that also writes; it cannot be asked without doing it. This reads the same rules
// from the root store, for the lines a forget matches there: the line itself, the lines that carry the same words (the same owner while the layout is `central`, the same kind account-wide
// otherwise), and the lines the line replaced (its older versions, found the other way round: from each lesson a skill came from, the lines that replaced it).
// What it cannot see: a lesson held only in another store of a split layout, and the audience check the forget adds for same-word lines. So the answer per line is
//   [skill…]   these skills were made from it (a skill found is always real),
//   []         none (certain: no applied skill promotion exists, or the layout is `central` and every agent could be read),
//   undefined  not known (a split layout, or an agent whose proposals could not be read, and no skill found).
import { getMemoryDb } from "./database";
import { layoutOf } from "./stores";
import { memoryAuthorityOwnerKeys, memoryContentHash, memoryOwnerKey } from "./revocations";
import type { OwnerMemoryRecord } from "./owner-mutations";

export interface DerivedSkill { agentId: string; skillName: string; proposalId: string }

const CHAIN_DEPTH = 16;   // the engine's FORGET_CHAIN_MAX_DEPTH (revocations.ts): the same number of generations
const MAX_SOURCE_LESSONS = 400;

type KeyRow = { id: string; scope: string; kind: string; content: string; project_id: string | null; project_path: string | null; agent_id: string | null; chat_id: string | null; actor_id: string | null };

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

/** The lines that replaced `id`, and the ones those replaced, up to the chain depth (root store). Mirrors the three places a replacement is written (revocations.ts `olderVersionIds`), read from the older side. */
function newerVersions(db: ReturnType<typeof getMemoryDb>, startIds: readonly string[]): Map<string, Set<string>> {
  const newerOf = new Map<string, Set<string>>();   // newer line id -> the source lesson ids it replaced (directly or through a chain)
  const reach = new Map<string, Set<string>>();     // lesson id -> every line reached from it
  for (const start of startIds) reach.set(start, new Set());
  let frontier = new Map<string, Set<string>>(startIds.map(id => [id, new Set([id])]));   // line id -> the lessons it descends from
  for (let depth = 0; depth < CHAIN_DEPTH && frontier.size; depth += 1) {
    const next = new Map<string, Set<string>>();
    const link = (older: string, newer: string): void => {
      const roots = frontier.get(older);
      if (!roots || newer === older) return;
      for (const root of roots) {
        if (reach.get(root)!.has(newer)) continue;
        reach.get(root)!.add(newer);
        let bucket = next.get(newer); if (!bucket) next.set(newer, bucket = new Set()); bucket.add(root);
      }
    };
    const ids = [...frontier.keys()];
    for (const id of ids) {
      try { for (const row of db.prepare("SELECT id FROM memory_entries WHERE instr(evidence_json, ?) > 0").all(`"supersedes:${id}"`) as Array<{ id: string }>) link(id, row.id); } catch { /* no evidence column to read */ }
    }
    for (const part of chunks(ids, 400)) {
      const marks = part.map(() => "?").join(",");
      try { for (const row of db.prepare(`SELECT memory_id, source_id FROM memory_origin_links WHERE source_kind='memory' AND relation='supersedes' AND source_id IN (${marks})`).all(...part) as Array<{ memory_id: string; source_id: string }>) link(row.source_id, row.memory_id); } catch { /* no link table */ }
      try { for (const row of db.prepare(`SELECT from_memory_id, to_memory_id FROM memory_relation_edges WHERE relation_type='supersedes' AND to_memory_id IN (${marks})`).all(...part) as Array<{ from_memory_id: string; to_memory_id: string }>) link(row.to_memory_id, row.from_memory_id); } catch { /* no edge table */ }
    }
    frontier = next;
  }
  for (const [lesson, lines] of reach) for (const line of lines) { let bucket = newerOf.get(line); if (!bucket) newerOf.set(line, bucket = new Set()); bucket.add(lesson); }
  return newerOf;
}

/**
 * The skills made from each of these lines. One map entry per record id: an array (none, one or several) or `undefined` (not known). Never throws: a store that cannot be read is "not known".
 */
export function derivedSkillsForRecords(records: readonly OwnerMemoryRecord[]): Map<string, DerivedSkill[] | undefined> {
  const result = new Map<string, DerivedSkill[] | undefined>();
  const unknownAll = (): Map<string, DerivedSkill[] | undefined> => { for (const record of records) result.set(record.id, undefined); return result; };
  if (!records.length) return result;
  let sources: ReturnType<typeof import("../agents/workspace-service").allAppliedSkillSources>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sources = (require("../agents/workspace-service") as typeof import("../agents/workspace-service")).allAppliedSkillSources();
  } catch { return unknownAll(); }
  if (!sources.sources.length) {
    // No applied skill promotion anywhere that could be read: nothing was made from any line. An agent that could not be read might hold one.
    for (const record of records) result.set(record.id, sources.complete ? [] : undefined);
    return result;
  }
  try {
    const db = getMemoryDb();
    const central = layoutOf(db) === "central";
    const lessons = [...new Set(sources.sources.flatMap(source => source.memoryEntryIds))];
    if (lessons.length > MAX_SOURCE_LESSONS) return unknownAll();
    const keyRows = new Map<string, KeyRow>();
    for (const part of chunks(lessons, 400)) {
      for (const row of db.prepare(`SELECT m.id,m.scope,m.kind,m.content,m.project_id,m.project_path,m.agent_id,m.chat_id,b.actor_id FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id WHERE m.id IN (${part.map(() => "?").join(",")}) AND m.content<>''`).all(...part) as KeyRow[]) keyRows.set(row.id, row);
    }
    const byHash = new Map<string, KeyRow[]>();
    for (const row of keyRows.values()) { const hash = memoryContentHash(row.content); let bucket = byHash.get(hash); if (!bucket) byHash.set(hash, bucket = []); bucket.push(row); }
    const newerOf = newerVersions(db, [...keyRows.keys()]);
    for (const record of records) {
      const matched = new Set<string>();
      if (keyRows.has(record.id)) matched.add(record.id);
      for (const lesson of newerOf.get(record.id) ?? []) matched.add(lesson);
      if (record.content) {
        const ownerKeys = central ? memoryAuthorityOwnerKeys({ scope: record.scope, projectId: record.project_id, projectPath: record.project_path, agentId: record.agent_id ?? record.actor_id, chatId: record.chat_id }) : null;
        for (const row of byHash.get(memoryContentHash(record.content)) ?? []) {
          if (row.kind !== record.kind) continue;
          if (central && (row.scope !== record.scope || !ownerKeys!.includes(memoryOwnerKey({ scope: row.scope as OwnerMemoryRecord["scope"], projectId: row.project_id, projectPath: row.project_path, agentId: row.agent_id ?? row.actor_id, chatId: row.chat_id })))) continue;
          matched.add(row.id);
        }
      }
      const found: DerivedSkill[] = [];
      const seen = new Set<string>();
      for (const source of sources.sources) {
        if (!source.memoryEntryIds.some(id => matched.has(id))) continue;
        const key = `${source.agentId}\u0000${source.proposalId}\u0000${source.skillName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ agentId: source.agentId, skillName: source.skillName, proposalId: source.proposalId });
      }
      result.set(record.id, found.length ? found : central && sources.complete ? [] : undefined);
    }
    return result;
  } catch { return unknownAll(); }
}
