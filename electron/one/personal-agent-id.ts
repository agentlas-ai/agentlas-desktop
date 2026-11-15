import { BUILTIN_ONE_AGENT_ID, BUILTIN_ORCHESTRATOR_AGENT_ID } from "../../shared/builtin-agent-ids";

/*
 * The personal agent (One) is the owner's assistant, not a member of any room.
 * This is the one place that says which ids those are, so a room's member list, the seating of a new Agent Chat and the
 * team's own normaliser all agree. It is a pure id check plus one optional slug probe; it never throws.
 */

const PERSONAL_SLUGS = new Set(["agentlas-one", "agentlas-orchestrator"]);
const PERSONAL_IDS = new Set<string>([BUILTIN_ONE_AGENT_ID, BUILTIN_ORCHESTRATOR_AGENT_ID]);

/** The built-in ids, no store read. */
export function isBuiltinPersonalAgentId(agentId: unknown): boolean {
  return typeof agentId === "string" && PERSONAL_IDS.has(agentId.trim());
}

/** The built-in ids, or an installed row that carries one of the built-in slugs (an id copied under another id). */
export function isPersonalAgentId(agentId: unknown): boolean {
  if (typeof agentId !== "string") return false;
  const id = agentId.trim();
  if (!id) return false;
  if (PERSONAL_IDS.has(id)) return true;
  try {
    const { getDb } = require("../store/db") as typeof import("../store/db"); // eslint-disable-line @typescript-eslint/no-require-imports
    const row = getDb().prepare("SELECT slug FROM installed_agents WHERE id = ?").get(id) as { slug?: string } | undefined;
    return Boolean(row?.slug && PERSONAL_SLUGS.has(row.slug));
  } catch {
    return false;
  }
}

/** Splits a list into the ids a room may hold and the personal-agent ids that were left out (order kept, duplicates dropped). */
export function withoutPersonalAgents(ids: readonly unknown[]): { kept: string[]; excluded: string[] } {
  const kept: string[] = [];
  const excluded: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || kept.includes(id) || excluded.includes(id)) continue;
    (isPersonalAgentId(id) ? excluded : kept).push(id);
  }
  return { kept, excluded };
}
