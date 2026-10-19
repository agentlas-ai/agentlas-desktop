import type { Automation, WorkflowNode } from "../../shared/types";
import { getAutomation } from "../store/automations";
import { getChat } from "../store/chats";
import { currentOneGraphAuthority } from "./graph-ownership";




















export const GRAPH_STEP_TEAM_TOOLS = Object.freeze([
  "one_team_list", "one_team_start_session", "one_team_steer", "one_team_session_status",
  "one_team_create_member", "one_team_invite", "one_team_compose_group",
] as const);
export const GRAPH_STEP_TEAM_READ_TOOLS = Object.freeze(["one_team_list", "one_team_session_status"] as const);
/**
 * Per-item outside-effect tools of the step's automation occurrence (one/graph-effect-items.ts). A write step checks an
 * item before publishing and records its published id after; a read step (a verifier) may only check. The automation,
 * occurrence, run and step come from this grant, never from the model.
 */
export const GRAPH_STEP_EFFECT_ITEM_TOOLS = Object.freeze(["effect_item_check", "effect_item_record"] as const);
export const GRAPH_STEP_EFFECT_ITEM_READ_TOOLS = Object.freeze(["effect_item_check"] as const);

/** One Team control operation -> the tool name a graph-step capability must hold for it (team-control-server). */
export const GRAPH_STEP_TEAM_OPERATION_TOOL: Readonly<Record<string, string>> = Object.freeze({
  list: "one_team_list", start: "one_team_start_session", steer: "one_team_steer", status: "one_team_session_status",
  create: "one_team_create_member", invite: "one_team_invite", compose_group: "one_team_compose_group",
});

export interface GraphTeamGrant {
  readonly automationId: string;
  readonly nodeId: string;
  readonly runId: string;
  /** The step's own session chat (the run's chatId). */
  readonly chatId: string;
  /** The group room that saved the graph; the capability acts for it. */
  readonly ownerChatId: string;
  readonly authorityDigest: string;
  readonly permission: "read" | "write";
  readonly tools: readonly string[];
  /** The run's durable occurrence (graph checkpoint), the scope of the per-item effect record. */
  readonly occurrenceId: string | null;
  /** GRAPH_STEP_EFFECT_ITEM_TOOLS for a write step, the check alone for a read step. */
  readonly effectTools: readonly string[];
}

// Object identity is the authority: a copied or deserialized grant is never current.
const minted = new WeakSet<object>();
const revoked = new WeakSet<object>();
// Live (minted, not revoked) grants by the step's own chat and by "<runId>#<nodeId>": the per-item effect record and the
// browser publish admission find the step a session acts for here (one/graph-effect-items.ts).
const liveByChat = new Map<string, GraphTeamGrant>();
const liveByOwner = new Map<string, GraphTeamGrant>();
const ownerKey = (runId: string, nodeId: string): string => `${runId}#${nodeId}`;

function groupRoomAuthority(automation: Automation): { ownerChatId: string; digest: string } | null {
  const authority = currentOneGraphAuthority(automation);
  if (!authority) return null;
  const owner = getChat(authority.ownerChatId);
  return owner && owner.originSurface === "one" && owner.seatKind === "group" && !owner.archivedAt ? authority : null;
}

/** Called by the graph runner when an agent/action step starts. Null = this step gets nothing new. */
export function mintGraphTeamGrant(input: {
  automationId: string; node: Pick<WorkflowNode, "id" | "type" | "config">; runId: string; chatId: string;
  effect: "pure" | "read" | "mutation"; dryRun: boolean; permissionCeiling?: "read" | "write"; occurrenceId?: string | null;
}): GraphTeamGrant | null {
  if (input.dryRun || (input.node.type !== "agent" && input.node.type !== "action")) return null;
  if (input.node.config && Object.hasOwn(input.node.config, "mcpCall")) return null;
  const automation = getAutomation(input.automationId);
  if (!automation || !automation.graph?.nodes.some((node) => node.id === input.node.id)) return null;
  const authority = groupRoomAuthority(automation);
  if (!authority || authority.ownerChatId === input.chatId) return null;
  const write = input.effect === "mutation" && automation.executionPermission === "write" && input.permissionCeiling !== "read";
  const grant: GraphTeamGrant = Object.freeze({
    automationId: automation.id, nodeId: input.node.id, runId: input.runId, chatId: input.chatId,
    ownerChatId: authority.ownerChatId, authorityDigest: authority.digest,
    permission: write ? "write" as const : "read" as const,
    tools: Object.freeze([...(write ? GRAPH_STEP_TEAM_TOOLS : GRAPH_STEP_TEAM_READ_TOOLS)]),
    occurrenceId: typeof input.occurrenceId === "string" && input.occurrenceId.trim() ? input.occurrenceId : null,
    effectTools: Object.freeze([...(write ? GRAPH_STEP_EFFECT_ITEM_TOOLS : GRAPH_STEP_EFFECT_ITEM_READ_TOOLS)]),
  });
  minted.add(grant);
  liveByChat.set(grant.chatId, grant);
  liveByOwner.set(ownerKey(grant.runId, grant.nodeId), grant);
  return grant;
}

/** Minted here, not revoked, and the automation's authority is still exactly the one the step started with. */
export function graphTeamGrantCurrent(grant: unknown): grant is GraphTeamGrant {
  if (!grant || typeof grant !== "object" || !minted.has(grant) || revoked.has(grant)) return false;
  const g = grant as GraphTeamGrant;
  const automation = getAutomation(g.automationId);
  if (!automation) return false;
  const authority = groupRoomAuthority(automation);
  return Boolean(authority && authority.ownerChatId === g.ownerChatId && authority.digest === g.authorityDigest);
}

/** The step (or its run) ended: every capability minted from this grant stops answering. */
export function revokeGraphTeamGrant(grant: GraphTeamGrant | null | undefined): void {
  if (!grant) return;
  revoked.add(grant);
  if (liveByChat.get(grant.chatId) === grant) liveByChat.delete(grant.chatId);
  const key = ownerKey(grant.runId, grant.nodeId);
  if (liveByOwner.get(key) === grant) liveByOwner.delete(key);
}

/** The current grant of the step whose own chat this is, or null (one/graph-effect-items.ts). */
export function liveGraphTeamGrantForChat(chatId: string | null | undefined): GraphTeamGrant | null {
  const grant = chatId ? liveByChat.get(chatId) : undefined;
  return grant && graphTeamGrantCurrent(grant) ? grant : null;
}

/** The current grant of the step "<runId>#<nodeId>" (one_team_dispatches.graph_owner), or null. */
export function liveGraphTeamGrantForOwner(owner: string | null | undefined): GraphTeamGrant | null {
  const grant = owner ? liveByOwner.get(owner) : undefined;
  return grant && graphTeamGrantCurrent(grant) ? grant : null;
}
