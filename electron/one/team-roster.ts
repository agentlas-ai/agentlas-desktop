import type { InstalledAgent } from "../../shared/types";
import type { OneOrgMember } from "../../shared/one-org";
import { getDb } from "../store/db";
import { currentUiLocale } from "../ui-locale";
import { isBuiltinPersonalAgentId } from "./personal-agent-id";

// The two slugs personal-agent-id.ts names; a copy under another id still carries its slug (read from the row already in hand: no store read per agent).
const PERSONAL_SLUGS: ReadonlySet<string> = new Set(["agentlas-one", "agentlas-orchestrator"]);

/*
 * The roster the personal agent names agents from (Agentlas 2.0 D5, section 2 item 7).
 *
 * It is the agent REGISTRY - `installed_agents`, the agents registered on this computer with their home folder - and not the seat table
 * `one_org_members`. A seat is only what a room join leaves behind (`ensureOneOrgSeat`); an agent the owner registered and never put in a room has none and is
 * still an agent the owner can ask for. Whether an agent may be used is not decided here: that is `agentUsability` (agents/usability.ts), the one question every
 * place asks; this file only reads who exists and joins the seat (when there is one) for the work status.
 *
 * Not on the roster: the personal agent itself (the assistant, never a room member), the built-in agents (Finance, Science, the curator... have no character and
 * no place in a chat of the owner's), a hidden or background row, a team's internal member (it is run through its team), a team package.
 * The list is a read: it writes nothing and calls no model.
 */

export interface RosterEntry {
  agentId: string;
  slug: string;
  /** The name the owner knows: the seat's own name, else the owner's local name, else the package name. */
  name: string;
  nameEn: string;
  agent: InstalledAgent;
  /** The seat the agent holds (a room join made it), or null. An archived seat is null here and `archivedSeat` says so. */
  seat: OneOrgMember | null;
  archivedSeat: boolean;
  /** Archived in Settings (30 days unused) or removed from the owner's people: not offered by the list, still found by a name so the refusal can say why. */
  hidden: boolean;
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function builtinAgentIds(): Set<string> {
  try { return new Set((getDb().prepare("SELECT id FROM installed_agents WHERE builtin = 1").all() as Array<{ id: string }>).map((row) => row.id)); } catch { return new Set(); }
}

/** The registered agents the personal agent may name, newest registration first. `includeHidden` adds the archived ones (a name lookup needs them to refuse precisely). */
export function registeredRoster(options: { includeHidden?: boolean } = {}): RosterEntry[] {
  const builtin = builtinAgentIds();
  const org = (require("./org") as typeof import("./org")); // eslint-disable-line @typescript-eslint/no-require-imports
  const seats = new Map<string, OneOrgMember>();
  const archivedSeats = new Set<string>();
  try {
    for (const member of org.getOneOrgState().members) {
      if (member.archivedAt) { if (!seats.has(member.installedAgentId)) archivedSeats.add(member.installedAgentId); continue; }
      if (!seats.has(member.installedAgentId)) seats.set(member.installedAgentId, member);
    }
  } catch { /* a store with no seat table has no seats: the registry still lists */ }
  let archivedAgents: ReadonlySet<string> = new Set<string>();
  try { archivedAgents = (require("../archive/auto-archive") as typeof import("../archive/auto-archive")).archivedAgentIds(); } catch { /* no archive state */ } // eslint-disable-line @typescript-eslint/no-require-imports
  const out: RosterEntry[] = [];
  const { listInstalledAgentsReadOnly } = require("../mcp/registry") as typeof import("../mcp/registry"); // eslint-disable-line @typescript-eslint/no-require-imports
  for (const agent of listInstalledAgentsReadOnly()) {
    if (agent.visibility && agent.visibility !== "visible") continue;
    if (agent.parentTeamId || agent.kind === "team") continue;
    if (builtin.has(agent.id) || isBuiltinPersonalAgentId(agent.id) || PERSONAL_SLUGS.has(agent.slug)) continue;
    const seat = seats.get(agent.id) ?? null;
    const hidden = archivedAgents.has(agent.id) || (!seat && archivedSeats.has(agent.id));
    if (hidden && !options.includeHidden) continue;
    out.push({
      agentId: agent.id, slug: agent.slug, name: seat?.displayName || agent.localDisplayName || agent.name || agent.slug,
      nameEn: agent.nameEn || agent.name || agent.slug, agent, seat, archivedSeat: archivedSeats.has(agent.id), hidden,
    });
  }
  return out;
}

/** Name, slug or id words of an entry that a query is matched against. */
function wordsOf(entry: RosterEntry): string[] {
  return [entry.seat?.id, entry.agentId, entry.slug, entry.name, entry.nameEn, entry.agent.localDisplayName, entry.agent.name]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

/**
 * The entries a model's search words match: a name, slug or id (exact first, else contained), or, for the list's `query`, a word of the one-line description.
 * The words are the model's own query for a tool, not the owner's sentence: nothing here reads what a person wrote.
 */
export function matchRoster(entries: readonly RosterEntry[], query: string, options: { describe?: boolean; exactOnly?: boolean } = {}): RosterEntry[] {
  const wanted = normalize(query);
  if (!wanted) return [...entries];
  const exact = entries.filter((entry) => wordsOf(entry).some((value) => normalize(value) === wanted));
  if (exact.length > 0 || options.exactOnly === true) return exact;
  return entries.filter((entry) => wordsOf(entry).some((value) => normalize(value).includes(wanted))
    || (options.describe === true && [entry.agent.tagline, entry.agent.taglineEn].some((value) => typeof value === "string" && normalize(value).includes(wanted))));
}

/** The error a name that matches nobody or several gets: closed prefix, the names to choose from, and the fact that nothing was changed. */
export function rosterLookupError(query: string, pool: readonly RosterEntry[], all: readonly RosterEntry[]): Error {
  const ko = currentUiLocale() === "ko";
  if (pool.length === 0) {
    const names = all.filter((entry) => !entry.hidden).slice(0, 12).map((entry) => entry.name).join(", ");
    return new Error(ko
      ? `one-team-member-not-found: "${query}"에 맞는 에이전트가 등록돼 있지 않아요. 등록된 에이전트(일부): ${names || "(없음)"}. one_team_list 의 query 로 찾아 보세요. 아무것도 시작되지 않았어요. 없는 역할이면 one_team_create_member 로 먼저 만드세요.`
      : `one-team-member-not-found: no registered agent matches "${query}". Registered (some): ${names || "(none)"}. Search with one_team_list query. Nothing was started. If nobody fits, create one first with one_team_create_member.`);
  }
  const matches = pool.slice(0, 8).map((entry) => entry.name).join(", ");
  return new Error(ko
    ? `one-team-member-ambiguous: "${query}"에 맞는 에이전트가 여럿이에요(${matches}). 정확한 이름이나 member_id 로 다시 하세요. 아무것도 시작되지 않았어요.`
    : `one-team-member-ambiguous: "${query}" matches ${matches}. Use the exact name or member id. Nothing was started.`);
}

/** One registered agent by a name, slug or id (a seat id still works: it is what earlier turns and sessions carry). Throws the closed lookup error. */
export function resolveRosterEntry(query: string): RosterEntry {
  const ko = currentUiLocale() === "ko";
  const wanted = typeof query === "string" ? query.trim() : "";
  if (!wanted) throw new Error(`one-team-member-required: ${ko ? "에이전트 이름을 적어 주세요(one_team_list 참고)." : "Name the agent (see one_team_list)."}`);
  const all = registeredRoster({ includeHidden: true });
  const pool = matchRoster(all, wanted);
  if (pool.length === 1) return pool[0]!;
  throw rosterLookupError(wanted, pool, all);
}
