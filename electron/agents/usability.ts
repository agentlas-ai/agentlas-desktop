// "Can this agent be used right now?" in Main: database and folder facts -> the pure rule (shared/agent-usability.ts). Agentlas 2.0 D6, decision.
//
// ★ ONE FUNCTION. Every place that picks, calls, seats or composes an agent asks `agentUsability` (or `gateInvocationTargets`, which asks it once per named agent):
//   the invocation (1:1, queue, room, team run, automation, graph node, Goal pass, Site Studio, a phone request), the seat/room joins and the personal agent's calls
//   end in `mcp/client.ts` invoke, where the gate sits. `scripts/test-d6-register-to-use.cjs` lists the call sites and fails when one is added that does not pass here.
// ★ THE SWITCH. The rule is on only with the 2.0 switch (`firstRunMigrationEnabled`, the same switch the migration and the workspace rules use). Off, every answer is
//   `usable: true, enforced: false` and nothing in the app changes.
// ★ A folder that VANISHED (drive unplugged, folder renamed: `reconnectable`) keeps the rule - the turn still runs from the stored prompt and the screen offers
// "reconnect". Only an agent that never had a folder is refused. Both read `no_folder`; `reconnectable` tells them apart.
import { decideUsability, hasRegistrationCharacter, passesGate, usabilityRefusalCode, usabilitySentence, type AgentUsability, type AgentUsabilityFacts, type AgentUsabilityRef, type UsabilityLocale } from "../../shared/agent-usability";
import { isCallOnlyHubAgent } from "../../shared/call-only-agent";
import { firstRunMigrationEnabled } from "../migration/gate";
import { getDb } from "../store/db";
import { isAgentArchived } from "../archive/auto-archive";
import { getRoute } from "./routes";

/**
 * The engine (Agentlas-OS agent_usability.py) asks the same registered question before `hephaestus call`; it turns its own door off when this value is "host": the desktop's door
 * (`gateInvocationTargets`) already judged the call, and asking twice would refuse what it allowed. Sent only while the desktop's own door is on (switch off: nothing, the engine decides
 * by itself), and only on the calls the desktop gated (`hepCall`), never on the engine tools a model calls directly.
 */
export const ENGINE_HOST_GATE_ENV = "AGENTLAS_AGENT_REGISTRATION_GATE";
export function engineHostGateEnv(): Record<string, string> { return usabilityEnforced() ? { [ENGINE_HOST_GATE_ENV]: "host" } : {}; }

/** The 2.0 switch for the "register to use" rule. A test may force it with the second argument of `agentUsability`. */
export function usabilityEnforced(): boolean { return firstRunMigrationEnabled(); }

interface Row {
  id: string; slug: string; builtin: number; visibility: string | null; role: string | null; system_prompt: string | null; parent_team_id: string | null; tone: string | null;
}

function rowById(agentId: string): Row | null {
  try { return (getDb().prepare("SELECT id, slug, builtin, visibility, role, system_prompt, parent_team_id, tone FROM installed_agents WHERE id = ?").get(agentId) as Row | undefined) ?? null; } catch { return null; }
}
function rowBySlug(slug: string): Row | null {
  try { return (getDb().prepare("SELECT id, slug, builtin, visibility, role, system_prompt, parent_team_id, tone FROM installed_agents WHERE slug = ?").get(slug) as Row | undefined) ?? null; } catch { return null; }
}

function orgArchived(agentId: string): boolean {
  try {
    // The newest seat of this agent decides: a person who was archived and seated again is not archived.
    const seat = getDb().prepare("SELECT archived_at FROM one_org_members WHERE installed_agent_id = ? ORDER BY added_at DESC, rowid DESC LIMIT 1").get(agentId) as { archived_at: string | null } | undefined;
    return Boolean(seat?.archived_at);
  } catch { return false; }
}

function folderFacts(row: Row): AgentUsabilityFacts["folder"] {
  try {
    // Loaded lazily: relocate.ts pulls the move machinery, which the pure rule and a screen-less caller do not need until a folder is asked about.
    const { agentFolderStatus } = require("./relocate") as typeof import("./relocate"); // eslint-disable-line @typescript-eslint/no-require-imports
    const status = agentFolderStatus(row.id);
    if (!status) return null;
    return { state: status.state, reconnectable: status.reconnectable };
  } catch { return null; }
}

/** The facts the rule reads, from the store. Exported for the gate that checks the facts, not for callers (they ask `agentUsability`). */
export function readUsabilityFacts(ref: AgentUsabilityRef): AgentUsabilityFacts {
  const byId = "agentId" in ref;
  const source = byId ? "local" : (ref.source ?? "local");
  const row = byId ? rowById(ref.agentId) : rowBySlug(ref.slug);
  const slug = byId ? (row?.slug ?? null) : ref.slug;
  if (!row) return { refKind: byId ? "agentId" : "slug", slug, source, row: null, archived: null, folder: null };
  const builtin = row.builtin === 1;
  const callOnly = isCallOnlyHubAgent({ assetSource: routeSource(row.id), systemPrompt: row.system_prompt });
  const internal = !builtin && (row.visibility === "background" || row.visibility === "private" || Boolean(row.parent_team_id));
  const archived = builtin ? null : isAgentArchived(row.id) ? "storage" : orgArchived(row.id) ? "org" : null;
  return {
    refKind: byId ? "agentId" : "slug",
    slug,
    source,
    row: { id: row.id, slug: row.slug, builtin, internal, callOnly, hasCharacter: hasRegistrationCharacter(row.tone), placeholder: row.role === "recovery-placeholder" },
    archived,
    // The folder is read only when the answer can depend on it: a built-in, an internal row, an archived row or a call-only row that was never registered is decided before it.
    folder: builtin || internal || archived || (callOnly && !hasRegistrationCharacter(row.tone)) ? null : folderFacts(row),
  };
}

function routeSource(agentId: string): "hub" | "agent-cloud" | "local-import" | null {
  try {
    const route = getRoute(agentId);
    return route?.source === "hub" ? "hub" : route?.source === "agent-cloud" ? "agent-cloud" : route ? "local-import" : null;
  } catch { return null; }
}

/**
 * The answer. With the switch off the answer is always `usable: true, enforced: false`; `options.enforce` forces it either way (the gate script and the screens' query).
 * A `slug` ref with `source: "hub" | "cloud"` is a Hub/Cloud listing: it is usable only when the same slug is registered here and passes the rule.
 */
export function agentUsability(ref: AgentUsabilityRef, options: { enforce?: boolean } = {}): AgentUsability {
  const enforced = options.enforce ?? usabilityEnforced();
  if (!enforced) return { usable: true, agentId: "agentId" in ref ? ref.agentId : null, enforced: false };
  return decideUsability(readUsabilityFacts(ref));
}

export interface UsabilityRefusal {
  code: string;
  message: string;
  /** What the owner can do: register something (`register`, with the slugs) or open the folder reconnect (`reconnect`) or restore (`restore`). */
  next: "register" | "reconnect" | "restore" | "none";
  slugs: string[];
  agentIds: string[];
  results: Array<Extract<AgentUsability, { usable: false }>>;
}

/** What a refusal says in the closed shape every refusal travels in. */
export function usabilityRefusalOf(results: Array<Extract<AgentUsability, { usable: false }>>, locale: UsabilityLocale): UsabilityRefusal {
  const first = results[0];
  const next: UsabilityRefusal["next"] = first.why === "not_registered" ? "register" : first.why === "no_folder" ? (first.reconnectable ? "reconnect" : "register") : first.why === "archived" ? "restore" : "none";
  return {
    code: usabilityRefusalCode(first),
    message: usabilitySentence(first, locale),
    next,
    slugs: [...new Set(results.map((item) => ("slug" in item ? item.slug : null)).filter((slug): slug is string => Boolean(slug)))],
    agentIds: [...new Set(results.map((item) => item.agentId).filter((id): id is string => Boolean(id)))],
    results,
  };
}

/**
 * The structured part of a refusal, for a screen or the phone that wants a "register" / "reconnect" / "restore" button without reading a sentence (the same words travel on
 * the error event of a turn as `error.register`, on a seat or room join as `.next` `.slugs` `.agentIds` of the thrown Error, and in an agent tool's answer).
 */
export interface UsabilityRegisterField { next: UsabilityRefusal["next"]; slugs: string[]; agentIds: string[] }
export function usabilityRegisterField(refusal: Pick<UsabilityRefusal, "next" | "slugs" | "agentIds">): UsabilityRegisterField {
  return { next: refusal.next, slugs: [...refusal.slugs], agentIds: [...refusal.agentIds] };
}

/** The shape of an explicit target the gate reads; the caller's own target type (`OrchestrationTarget`) satisfies it and comes back as it was. */
export type GateTarget =
  | { source: "local"; entityKind: "agent"; agentId: string }
  | { source: "local"; entityKind: "team"; firmId: string }
  | { source: "cloud" | "hub"; entityKind: "agent" | "team"; slug: string };

export interface InvocationTargets<T extends GateTarget> {
  /** The agent the chat belongs to. */
  chatAgentId: string | null;
  taskForceTargets?: readonly T[];
  borrowAgents?: readonly string[];
}

export interface InvocationGateResult<T extends GateTarget> {
  refusal: UsabilityRefusal | null;
  /** The explicit targets after the gate: a Hub/Cloud target whose slug is registered here and usable becomes the local agent (the folder runs, not the borrowed bundle). */
  taskForceTargets: readonly T[] | undefined;
}

/**
 * The invocation's gate: every agent a turn names (its chat agent, an explicit local target, a Hub/Cloud target, a borrowed slug) is asked once. The first refusal wins the
 * sentence; all unregistered slugs are listed so one "register" step can cover them. Off the switch: nothing is refused and nothing is rewritten.
 * `reconnectable` no-folder rows pass (the stored-prompt turn); everything else that is not usable refuses the whole turn before any model is called.
 */
export function gateInvocationTargets<T extends GateTarget>(input: InvocationTargets<T>, locale: UsabilityLocale, options: { enforce?: boolean } = {}): InvocationGateResult<T> {
  if (!(options.enforce ?? usabilityEnforced())) return { refusal: null, taskForceTargets: input.taskForceTargets };
  const refused: Array<Extract<AgentUsability, { usable: false }>> = [];
  const note = (result: AgentUsability): void => { if (!passesGate(result)) refused.push(result as Extract<AgentUsability, { usable: false }>); };
  if (input.chatAgentId) note(agentUsability({ agentId: input.chatAgentId }, { enforce: true }));
  let targets = input.taskForceTargets;
  if (targets) {
    targets = targets.map((target) => {
      if (target.source === "local") {
        if (target.entityKind !== "agent") return target;
        const result = agentUsability({ agentId: target.agentId }, { enforce: true });
        note(result);
        // A registered call-only agent has no instructions in its folder: its local target becomes the Hub target of its slug (the Hub is called), never an empty local run.
        if (result.usable && result.runsThroughHub && result.slug) return { source: "hub" as const, entityKind: "agent" as const, slug: result.slug } as unknown as T;
        return target;
      }
      const result = agentUsability({ slug: target.slug, source: target.source }, { enforce: true });
      // A registered agent named by its Hub/Cloud slug runs as that local agent (the folder runs, not the borrowed bundle) - except a call-only one, which stays the Hub target.
      const viaHub = result.usable && result.runsThroughHub === true;
      if (passesGate(result) && result.agentId && target.entityKind === "agent" && !viaHub) return { source: "local" as const, entityKind: "agent" as const, agentId: result.agentId } as unknown as T;
      note(result);
      return target;
    });
  }
  for (const slug of input.borrowAgents ?? []) {
    const trimmed = slug.trim();
    if (!trimmed) continue;
    note(agentUsability({ slug: trimmed, source: "hub" }, { enforce: true }));
  }
  return { refusal: refused.length ? usabilityRefusalOf(refused, locale) : null, taskForceTargets: targets };
}

/** An Error a caller can throw for a refusal (a seat or room join, a tool call): the sentence is the message, the closed code travels as `.code`. */
export function usabilityError(result: Extract<AgentUsability, { usable: false }>, locale: UsabilityLocale): Error & { code: string; next: UsabilityRefusal["next"]; slugs: string[]; agentIds: string[] } {
  const refusal = usabilityRefusalOf([result], locale);
  return Object.assign(new Error(refusal.slugs.length && refusal.next === "register" ? `${refusal.message} (${refusal.slugs.join(", ")})` : refusal.message), { code: refusal.code, next: refusal.next, slugs: refusal.slugs, agentIds: refusal.agentIds });
}

/**
 * The seat and room-join check: the agents that must be registered first (never registered, or no folder at all) refuse; the rest keep their own refusals (archived seat, hidden,
 * missing source ...) where they already are. Returns the refusal to throw, or null. Off the 2.0 switch: null.
 */
export function seatRefusalFor(agentId: string, locale: UsabilityLocale): ReturnType<typeof usabilityError> | null {
  const result = agentUsability({ agentId });
  if (result.usable) return null;
  if (result.why === "not_registered" || (result.why === "no_folder" && !result.reconnectable)) return usabilityError(result, locale);
  return null;
}
