import type { AgentModelLine, AgentModelOrderResult, AgentModelOrderView, RuntimeRole, RuntimeSelection } from "../../shared/types";
import { getDb } from "../store/db";
import { getResolvedModelRole, listModelRoleMembers } from "../store/model-roles";
import {
  AgentModelOrderError, readAgentModelOrder, writeAgentModelFollow, writeAgentOwnOrder, type AgentModelOrder,
} from "../store/agent-runtime-overrides";
import { runtimeSupportsAgentOverride } from "../../shared/runtime-selection";
import { defaultRoleForAgent } from "../runtime/agent-default-role";

/*
 * What the Manage-agents profile and the Dashboard read and write about an agent's model order.
 * Machine values only: the screen words them. The turn itself reads the order in runtime/selection.ts (selectRuntimeForTargets), at the
 * moment the turn starts; nothing here is a copy of the global order that could go stale.
 */

const lineOf = (selection: RuntimeSelection): AgentModelLine => ({
  kind: selection.kind,
  ...(selection.backend ? { backend: selection.backend } : {}),
  ...(selection.source ? { source: selection.source } : {}),
  ...(selection.acpAgentId ? { acpAgentId: selection.acpAgentId } : {}),
  model: selection.model ?? null,
  effort: selection.effort ?? null,
  longContext: Boolean(selection.longContext),
});
const selectionOf = (line: AgentModelLine): RuntimeSelection => ({
  kind: line.kind,
  ...(line.backend ? { backend: line.backend } : {}),
  ...(line.source ? { source: line.source } : {}),
  ...(line.acpAgentId ? { acpAgentId: line.acpAgentId } : {}),
  ...(line.model ? { model: line.model } : {}),
  ...(line.effort ? { effort: line.effort } : {}),
  longContext: Boolean(line.longContext),
});

/** The configured global order of a role (the pool rows; an empty Worker pool is the Orchestrator's; a store with no pool rows yet has its one resolved head). */
export function globalOrderLines(role: RuntimeRole): { lines: RuntimeSelection[]; inherited: boolean } {
  const own = listModelRoleMembers(role).map((member) => member.selection);
  if (own.length > 0) return { lines: own, inherited: false };
  if (role === "worker") return { lines: globalOrderLines("orchestrator").lines, inherited: true };
  const resolved = getResolvedModelRole(role)?.selection;
  return { lines: resolved ? [resolved] : [], inherited: false };
}

function agentExists(agentId: string): boolean {
  try { return Boolean(getDb().prepare("SELECT 1 FROM installed_agents WHERE id = ?").get(agentId)); } catch { return false; }
}

function viewOf(order: AgentModelOrder): AgentModelOrderView {
  const orchestrator = globalOrderLines("orchestrator");
  const worker = globalOrderLines("worker");
  const multimodal = globalOrderLines("multimodal");
  // Nothing chosen: the agent follows the Worker order in every turn kind, a one-to-one chat too. The personal agent and the Work controller
  // are set separately and start from the Orchestrator order, so they read "orchestrator" here. A Worker order nobody can start is the Orchestrator's
  // at the turn (runtime/selection.ts); the lines shown are the configured ones.
  const follow = order.explicit ? order.follow : defaultRoleForAgent(order.agentId);
  const effectiveLines = follow === "own" ? order.own : follow === "orchestrator" ? orchestrator.lines : worker.lines;
  return {
    agentId: order.agentId,
    follow,
    explicit: order.explicit,
    own: order.own.map(lineOf),
    effective: { source: follow, lines: effectiveLines.map(lineOf), first: effectiveLines[0] ? lineOf(effectiveLines[0]) : null },
    firstForChat: effectiveLines[0] ? lineOf(effectiveLines[0]) : null,
    global: {
      orchestrator: orchestrator.lines.map(lineOf),
      worker: worker.lines.map(lineOf),
      workerInherited: worker.inherited,
      multimodal: multimodal.lines.map(lineOf),
    },
    updatedAt: order.updatedAt,
  };
}

const fail = (code: Extract<AgentModelOrderResult, { ok: false }>["code"], message: string): AgentModelOrderResult => ({ ok: false, code, message });

export function readAgentModelOrderView(agentId: unknown): AgentModelOrderResult {
  if (typeof agentId !== "string" || !agentId.trim()) return fail("agent_id_invalid", "agent id is required");
  if (!agentExists(agentId)) return fail("agent_not_found", "no such agent");
  try { return { ok: true, order: viewOf(readAgentModelOrder(agentId)) }; }
  catch (error) { return error instanceof AgentModelOrderError ? fail(error.code, error.message) : fail("unavailable", "the model order could not be read"); }
}

/**
 * The agent follows "worker" or "orchestrator" (the global order is read at each turn), or "own". Choosing "own" from a following state fills
 * the first lines with the order it was following (a copy, the only copy there is: from then on the lines are the agent's own); choosing it again
 * while the agent already has its own lines changes nothing. A line that cannot be pinned to one agent (an ACP seat) is left out of the copy.
 */
export function setAgentModelFollow(agentId: unknown, follow: unknown): AgentModelOrderResult {
  if (typeof agentId !== "string" || !agentId.trim()) return fail("agent_id_invalid", "agent id is required");
  if (follow !== "worker" && follow !== "orchestrator" && follow !== "own") return fail("follow_invalid", "follow must be worker, orchestrator or own");
  if (!agentExists(agentId)) return fail("agent_not_found", "no such agent");
  try {
    const current = readAgentModelOrder(agentId);
    if (follow === "own") {
      if (current.follow !== "own") {
        const source = (current.explicit ? current.follow : defaultRoleForAgent(agentId)) === "orchestrator" ? "orchestrator" : "worker";
        const copy = globalOrderLines(source).lines.filter((line) => runtimeSupportsAgentOverride(line));
        if (copy.length === 0) return fail("own_order_nothing_to_copy", "the order this agent follows has no line that can be pinned to one agent; add a line to its own order instead");
        writeAgentOwnOrder(agentId, copy);
      }
    } else writeAgentModelFollow(agentId, follow);
    return { ok: true, order: viewOf(readAgentModelOrder(agentId)) };
  } catch (error) {
    return error instanceof AgentModelOrderError ? fail(error.code, error.message) : fail("unavailable", "the model order could not be saved");
  }
}

/** The agent's own lines, in order (the first is the primary, the rest are fallbacks). Switches the agent to its own order. */
export function setAgentOwnModelOrder(agentId: unknown, lines: unknown): AgentModelOrderResult {
  if (typeof agentId !== "string" || !agentId.trim()) return fail("agent_id_invalid", "agent id is required");
  if (!Array.isArray(lines)) return fail("own_order_line_invalid", "lines must be a list");
  if (!agentExists(agentId)) return fail("agent_not_found", "no such agent");
  const selections: RuntimeSelection[] = [];
  for (const raw of lines) {
    const line = raw as Partial<AgentModelLine> | null;
    if (!line || typeof line !== "object" || typeof line.kind !== "string") return fail("own_order_line_invalid", "a line needs a runtime kind");
    selections.push(selectionOf(line as AgentModelLine));
  }
  try {
    writeAgentOwnOrder(agentId, selections);
    return { ok: true, order: viewOf(readAgentModelOrder(agentId)) };
  } catch (error) {
    return error instanceof AgentModelOrderError ? fail(error.code, error.message) : fail("unavailable", "the model order could not be saved");
  }
}
