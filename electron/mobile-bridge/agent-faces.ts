import { getDb } from "../store/db";
import { readAgentAppearances } from "../agents/appearance-store";
import { appearancePrincipal } from "../agents/appearance-principal";
import { agentFace, agentFaceSeedName, type AgentFace } from "../../shared/agent-face";
import { agentDisplayName, type AgentNameFields } from "../../shared/agent-display-name";

/**
 * The picture the phone draws for each agent, decided by the same function as the Desktop's AgentAvatar (shared/agent-face.ts):
 * the face the owner chose > the default face of the agent's own name (language-independent seed: owner's name, else package name) > none.
 * The chosen faces of the whole list are read together, once (never one read per agent). When the owner is not known yet or the store cannot be
 * read, every agent keeps its default face (the Desktop draws the same until the chosen faces can be read).
 * Used by the Main app and the background helper alike: both build the phone's lists through the same projector / workspace-v2 modules.
 */
export function projectAgentFaces(agents: ReadonlyArray<AgentNameFields & { id: string }>): Map<string, AgentFace | null> {
  let chosen = new Map<string, import("../../shared/agent-appearance").AgentAppearance | null>();
  try { chosen = readAgentAppearances(getDb(), appearancePrincipal(), agents.map((agent) => agent.id)); } catch { /* default faces */ }
  return new Map(agents.map((agent) => [agent.id, agentFace(chosen.get(agent.id) ?? null, agentFaceSeedName(agent))] as const));
}

/** `{ face }` to spread into a phone row, or nothing when there is no face (an empty name). */
export function faceField(face: AgentFace | null | undefined): { face?: AgentFace } {
  return face ? { face } : {};
}

export interface NamePair { name: string; nameEn: string }

/**
 * The names of installed agents in both UI languages by the Desktop's own rule (shared/agent-display-name.ts: the owner's name wins in both, the English UI
 * takes the package's English name when it has one), read for the given ids in one statement. An id that is not installed here is not in the map.
 */
export function projectAgentNamePairs(agentIds: readonly string[]): Map<string, NamePair> {
  const out = new Map<string, NamePair>();
  const ids = [...new Set(agentIds.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 256))];
  try {
    for (let from = 0; from < ids.length; from += 400) {
      const chunk = ids.slice(from, from + 400);
      const rows = getDb().prepare(`SELECT id, name, name_en AS nameEn, local_display_name AS localDisplayName, slug FROM installed_agents WHERE id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Array<AgentNameFields & { id: string }>;
      for (const row of rows) out.set(row.id, { name: agentDisplayName(row, "ko"), nameEn: agentDisplayName(row, "en") });
    }
  } catch { /* no pairs: the phone keeps the one name it has */ }
  return out;
}

/** `{ nameEn }` to spread into a phone row when the English-UI name differs from `name`. */
export function nameEnField(name: string, nameEn: string | undefined | null, limit = 512): { nameEn?: string } {
  const en = (nameEn ?? "").trim().slice(0, limit);
  return en && en !== name ? { nameEn: en } : {};
}
