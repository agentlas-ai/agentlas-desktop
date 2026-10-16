import type { Automation, WorkflowNode } from "../../shared/types";
import { getAutomation } from "../store/automations";
import { getChat } from "../store/chats";
import { currentOneGraphAuthority } from "./graph-ownership";

/*
 * Owner decision 2026-10-16 ("방 범위 권한 허용"): an agent/action step of a graph that a group room's One saved gets
 * that room's One Team for the step's run, and nothing wider.
 *
 * Before this, a graph step never had One Team: only One's own conversation and a One Goal's continuation automation
 * do (team-dispatch.ts continuationOwnerChat), and the graph authority receipt (graph-ownership.ts) was honoured only
 * by fixed mcp_call steps. The daily "TCIagent YouTube" graph (saved by the Yotube room's One, step prompts that call
 * one_team_list / one_team_start_session / one_team_steer / one_team_session_status) therefore could never produce.
 *
 * Scope, all of it checked by the host, none of it read from the model or a payload:
 *   - only a step whose automation carries a CURRENT one_graph_authority (receipt digest = the definition now) owned by a
 *     group room; re-checked when the step starts (mint), when its MCP config is built, and on every One Team call;
 *   - the room-owned capability (chatId = the room), permission = the step's (mutation -> write, else read) capped at the
 *     automation's executionPermission;
 *   - tools: the room's list minus the graph/Toolchain control surface (ONE_GRAPH_TOOL_NAMES), i.e. the seven below; a
 *     read step gets one_team_list and one_team_session_status only;
 *   - never for a dry run, never for an mcp_call step (it already has its own authority path), revoked when the step ends.
 */

export const GRAPH_STEP_TEAM_TOOLS = Object.freeze([
  "one_team_list", "one_team_start_session", "one_team_steer", "one_team_session_status",
  "one_team_create_member", "one_team_invite", "one_team_compose_group",
] as const);
export const GRAPH_STEP_TEAM_READ_TOOLS = Object.freeze(["one_team_list", "one_team_session_status"] as const);

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
}

// Object identity is the authority: a copied or deserialized grant is never current.
const minted = new WeakSet<object>();
const revoked = new WeakSet<object>();

function groupRoomAuthority(automation: Automation): { ownerChatId: string; digest: string } | null {
  const authority = currentOneGraphAuthority(automation);
  if (!authority) return null;
  const owner = getChat(authority.ownerChatId);
  return owner && owner.originSurface === "one" && owner.seatKind === "group" && !owner.archivedAt ? authority : null;
}

/** Called by the graph runner when an agent/action step starts. Null = this step gets nothing new. */
export function mintGraphTeamGrant(input: {
  automationId: string; node: Pick<WorkflowNode, "id" | "type" | "config">; runId: string; chatId: string;
  effect: "pure" | "read" | "mutation"; dryRun: boolean; permissionCeiling?: "read" | "write";
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
  });
  minted.add(grant);
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
  if (grant) revoked.add(grant);
}
