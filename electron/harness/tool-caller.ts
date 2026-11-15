import type Database from "better-sqlite3";
import { memoryActorKind } from "../../shared/memory-ownership";
import { isPersonalAgentConversation } from "../workspace-rules/scope";

/*
 * Who is calling an agent tool. One function, host facts only.
 *
 * Every agent tool call (harness_call, one_app_call, the one-team tools) reaches Main through a capability the host minted for exactly one
 * conversation and one run (turn-tools/control-server.ts, one/team-control-server.ts). That binding is the only thing the call carries: the
 * model can name neither. The caller is read from it here, from rows the app already keeps (the chat, its agent, its project, the personal
 * agent's own-conversation condition) and from one in-process fact (a borrowed node of this run is live). Nothing is read from a model's
 * output, a word list or an argument.
 *
 *   owner-surface  the owner's own screen or phone (chat "ui"): never gated here (the screen's own IPC is the owner's click)
 *   personal       the personal agent's own conversation (desktop, phone, Telegram, mail); `ownerTurn` says the owner wrote this turn
 *   agent          any other conversation of one agent (a Work session, an agent 1:1 chat): its own chat, its project, its own agent
 *   member         a room member's hidden session (the room's, the lead-room model or the older delegation)
 *   guest          a borrowed Hub / Cloud agent, a call that carries no resolvable conversation, a chat this store cannot read: the narrowest
 *
 * A caller that cannot be told is a guest (unknown means narrowest). The same resolver serves every executor: the seven subscription CLIs,
 * the API-style and local loops, the daemon and the phone bridge all end at the same two control servers with the same binding.
 */
export type ToolCallerKind = "owner-surface" | "personal" | "agent" | "member" | "guest";

export interface ToolCaller {
  kind: ToolCallerKind;
  chatId: string;
  runId: string;
  /** The installed agent this conversation belongs to (null: a Work session or the personal agent has none of its own). */
  agentId: string | null;
  /** The conversations this caller may call its own: itself and its parent chain up to (never including) a personal agent's conversation. */
  family: readonly string[];
  /** The project of this conversation (of its root when it is a child), or null. */
  projectId: string | null;
  /** The owner wrote this turn (the personal agent only: the supervisor's sealed provenance for this run). */
  ownerTurn: boolean;
  /** Closed word: how the kind was decided. */
  basis: "owner-surface" | "guest-node-live" | "unresolved" | "hub-seat" | "hub-agent" | "personal-conversation" | "room-member" | "conversation";
}

const MAX_FAMILY_DEPTH = 8;

/* ── borrowed nodes live in this run ──────────────────────────────────────────────────────────────────────────────────────────────── */

/*
 * A team run's borrowed (Hub / Cloud) node runs under the PARENT turn's tool config (one capability for all the run's nodes: mcp/client.ts hands
 * every node `mcpConfigPath`). The capability cannot tell the node's call from the parent's, so while a borrowed node of a run is live, every
 * call that carries that run is read as a guest's. This only narrows: a sibling local node loses the sensitive operations for the time a guest
 * works beside it, and nothing a guest could not do is opened. A counter per run, released in `finally`; it holds no data and ends with the run.
 */
const guestNodesByRun = new Map<string, number>();

/** Mark one borrowed node live for a run; the returned function ends it (call it once, in a `finally`). */
export function enterGuestNode(runId: string | null | undefined): () => void {
  if (!runId) return () => undefined;
  guestNodesByRun.set(runId, (guestNodesByRun.get(runId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (guestNodesByRun.get(runId) ?? 1) - 1;
    if (left <= 0) guestNodesByRun.delete(runId); else guestNodesByRun.set(runId, left);
  };
}

export function guestNodeLive(runId: string | null | undefined): boolean {
  return Boolean(runId) && (guestNodesByRun.get(runId as string) ?? 0) > 0;
}

/* ── resolution ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */

interface ChatFacts { id: string; kind: string | null; parent: string | null; projectId: string | null; agentId: string | null }

function chatFacts(db: Database.Database, chatId: string): ChatFacts | null {
  try {
    const row = db.prepare("SELECT id, kind, parent_chat_id AS parent, project_id AS projectId, agent_id AS agentId FROM chats WHERE id = ?").get(chatId) as ChatFacts | undefined;
    return row ?? null;
  } catch { return null; }
}

/** The chat itself and its parents, stopping before a personal agent's conversation (a teammate's session does not own the owner's own talk). */
export function conversationFamily(db: Database.Database, chatId: string): { family: string[]; projectId: string | null; root: ChatFacts | null } {
  const family: string[] = [];
  let projectId: string | null = null;
  let root: ChatFacts | null = null;
  let id: string | null = chatId;
  for (let depth = 0; id && depth < MAX_FAMILY_DEPTH; depth += 1) {
    if (family.includes(id)) break;
    const facts = chatFacts(db, id);
    if (!facts) break;
    if (depth > 0 && isPersonalAgentConversation(db, id)) break;
    family.push(id);
    root = facts;
    projectId = projectId ?? facts.projectId ?? null;
    id = facts.parent;
  }
  return { family, projectId, root };
}

function hubSeat(db: Database.Database, agentId: string | null): boolean {
  if (!agentId) return false;
  if (memoryActorKind(agentId) === "hub") return true;
  try {
    const seat = db.prepare("SELECT source FROM one_org_members WHERE installed_agent_id = ? AND archived_at IS NULL LIMIT 1").get(agentId) as { source?: string } | undefined;
    if (seat?.source === "hub") return true;
  } catch { /* fall through to the agent's own row */ }
  // Agentlas 2.0 D6: a call-only Hub agent (no instructions of its own, a Hub route) is registered like any agent and is then used in chats with no org seat at all.
  // The card's owner keeps the source, so it is a third party whether or not it is registered or seated: it reaches nothing of the owner's.
  try {
    const row = db.prepare("SELECT system_prompt FROM installed_agents WHERE id = ?").get(agentId) as { system_prompt?: string | null } | undefined;
    if (row && !(row.system_prompt ?? "").trim()) {
      const { getRoute } = require("../agents/routes") as typeof import("../agents/routes"); // eslint-disable-line @typescript-eslint/no-require-imports
      return getRoute(agentId)?.source === "hub";
    }
  } catch { /* a process with no route file cannot tell: not a hub seat by this test */ }
  return false;
}

let ownerTurnProbe: ((runId: string) => boolean | Promise<boolean>) | null = null;
/** Test seam: the gate answers "the owner wrote this run" without a supervisor service. Never set in production. */
export function setPersonalOwnerTurnProbe(probe: ((runId: string) => boolean | Promise<boolean>) | null): void { ownerTurnProbe = probe; }

/** The owner wrote this turn of the personal agent: the same sealed provenance one_app_call and harness app.call read (harness/capability-ports.ts). */
async function personalOwnerTurn(runId: string): Promise<boolean> {
  if (ownerTurnProbe) return Boolean(await ownerTurnProbe(runId));
  try {
    const host = await import("../one/supervisor");
    const service = host.supervisorRunsInDaemon() ? host.oneSupervisor() : (await import("../one/supervisor-native-runtime")).oneSupervisorEndpoint();
    return Boolean(await service.ownerTurn(runId));
  } catch { return false; }
}

const guest = (chatId: string, runId: string, basis: ToolCaller["basis"], facts?: Partial<ToolCaller>): ToolCaller => ({
  kind: "guest", chatId, runId, agentId: null, family: [], projectId: null, ownerTurn: false, basis, ...facts,
});

/**
 * The caller of a tool call, from the capability's chat and run. `ui` (the owner's screen, the phone's relay under the owner's session) is the
 * owner's own hand. A run with no resolvable conversation is a guest.
 */
export async function resolveToolCaller(input: { chatId: string | null | undefined; runId: string | null | undefined }, db?: Database.Database): Promise<ToolCaller> {
  const chatId = typeof input.chatId === "string" ? input.chatId : "";
  const runId = typeof input.runId === "string" ? input.runId : "";
  if (chatId === "ui") return { kind: "owner-surface", chatId, runId, agentId: null, family: [], projectId: null, ownerTurn: true, basis: "owner-surface" };
  if (!chatId) return guest(chatId, runId, "unresolved");
  if (guestNodeLive(runId)) return guest(chatId, runId, "guest-node-live");
  let database = db;
  if (!database) {
    // A process with no store at all (a gate, a tool host before it opened one) cannot tell anyone from anyone: it is an agent with nothing of its own, which reaches the
    // shared machinery only (every sensitive domain needs a conversation, an agent or a project of its own). A store that is open and does not know the chat is a guest.
    try { database = (await import("../store/db")).getDb(); } catch { return { kind: "agent", chatId, runId, agentId: null, family: [], projectId: null, ownerTurn: false, basis: "unresolved" }; }
  }
  const own = chatFacts(database, chatId);
  if (!own) return guest(chatId, runId, "unresolved");
  const { family, projectId } = conversationFamily(database, chatId);
  if (hubSeat(database, own.agentId)) return guest(chatId, runId, own.agentId && memoryActorKind(own.agentId) === "hub" ? "hub-agent" : "hub-seat", { agentId: own.agentId, family, projectId });
  if (isPersonalAgentConversation(database, chatId)) {
    return { kind: "personal", chatId, runId, agentId: null, family, projectId, ownerTurn: runId ? await personalOwnerTurn(runId) : false, basis: "personal-conversation" };
  }
  const member = own.kind === "division" && Boolean(own.parent);
  return { kind: member ? "member" : "agent", chatId, runId, agentId: own.agentId, family, projectId, ownerTurn: false, basis: member ? "room-member" : "conversation" };
}
