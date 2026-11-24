import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { parseAgentAppearance, type AgentAppearance } from "../../shared/agent-appearance";

type AgentRow = { installed_at: string; visibility: string | null; entity_kind: string | null };
type Stored = { installation: string; revision: number; appearance: AgentAppearance | null };
const prefix = "agent-appearance:v1:";
function key(principal: string, agentId: string) {
  return prefix + createHash("sha256").update(JSON.stringify([principal, agentId])).digest("hex");
}
function agent(db: Database.Database, id: string): AgentRow {
  if (typeof id !== "string" || !id.trim() || id.length > 256 || id.trim() !== id) throw Error("appearance_agent_invalid");
  const row = db.prepare("SELECT installed_at, visibility, entity_kind FROM installed_agents WHERE id = ?").get(id) as AgentRow | undefined;
  if (!row || !row.installed_at || row.visibility === "private" || row.visibility === "background" || row.entity_kind === "company-reference") throw Error("appearance_agent_missing");
  return row;
}
function decode(value: string): Stored {
  const row = JSON.parse(value) as Record<string, unknown>;
  if (!row || Array.isArray(row) || typeof row !== "object" || Object.keys(row).sort().join(",") !== "appearance,installation,revision" || typeof row.installation !== "string" || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) throw Error("appearance_corrupt");
  return { installation: row.installation, revision: Number(row.revision), appearance: parseAgentAppearance(row.appearance) };
}
export function getAgentAppearance(db: Database.Database, principal: string, id: string) {
  const installation = agent(db, id).installed_at;
  const record = db.prepare("SELECT value FROM meta WHERE key = ?").get(key(principal, id)) as { value: string } | undefined;
  const saved = record ? decode(record.value) : null;
  return { agentId: id, installation, revision: saved?.installation === installation ? saved.revision : 0, appearance: saved?.installation === installation ? saved.appearance : null };
}
export function setAgentAppearance(db: Database.Database, principal: string, id: string, installation: string, revision: number, value: unknown, check: () => void) {
  return db.transaction(() => {
    check(); const appearance = parseAgentAppearance(value), current = getAgentAppearance(db, principal, id);
    if (current.installation !== installation) throw Error("appearance_installation_changed");
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER || current.revision !== revision) throw Error("appearance_conflict");
    db.prepare("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key(principal, id), JSON.stringify({ installation, revision: revision + 1, appearance }));
    check(); return getAgentAppearance(db, principal, id);
  }).immediate();
}

const BATCH = 400;
/**
 * The chosen faces of many agents in two statements per 400 ids (the phone projection reads every agent of a list at once; it never
 * reads one by one). An agent with no saved face, a stale installation, a hidden/private agent or a corrupt record has none: null, never a throw.
 */
export function readAgentAppearances(db: Database.Database, principal: string, ids: readonly string[]): Map<string, AgentAppearance | null> {
  const out = new Map<string, AgentAppearance | null>();
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 256 && id.trim() === id))];
  for (let from = 0; from < unique.length; from += BATCH) {
    const chunk = unique.slice(from, from + BATCH);
    const rows = db.prepare(`SELECT id, installed_at, visibility, entity_kind FROM installed_agents WHERE id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Array<AgentRow & { id: string }>;
    const usable = rows.filter((row) => row.installed_at && row.visibility !== "private" && row.visibility !== "background" && row.entity_kind !== "company-reference");
    if (!usable.length) continue;
    const keys = new Map(usable.map((row) => [key(principal, row.id), row] as const));
    const saved = db.prepare(`SELECT key, value FROM meta WHERE key IN (${[...keys.keys()].map(() => "?").join(",")})`).all(...keys.keys()) as Array<{ key: string; value: string }>;
    for (const record of saved) {
      const row = keys.get(record.key);
      if (!row) continue;
      try { const stored = decode(record.value); out.set(row.id, stored.installation === row.installed_at ? stored.appearance : null); } catch { /* a corrupt record is no face */ }
    }
  }
  return out;
}
