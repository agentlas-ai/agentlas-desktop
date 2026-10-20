// What a graph is for, from its structure.
//
// A graph is recurring work in which AIs act on results — find topics worth posting, then the AIs in a group chat work on what
// came back — or work that runs on a schedule (monitor performance). A graph whose steps are only fixed code or tool calls on an
// input is not that: it is a tool. In practice the input-triggered graphs One saved were almost always
// made only of code steps and checks (verify these frames, recheck this post's status), and most of them ran once or twice.
// A deterministic tool the agents use again and again is a Toolchain (an MCP-shaped tool), not a saved graph; one used once is
// done directly. Structure only: no step text is read.

import type { WorkflowGraph, WorkflowNode } from "./types";

/** A step in which a model or a teammate does the work: an agent or action without a fixed tool call, a team call, a subgraph. */
export function graphNodeOrchestrates(node: Pick<WorkflowNode, "type" | "config">): boolean {
  const config = (node.config ?? {}) as Record<string, unknown>;
  const mcp = config.mcpCall as { catalogId?: unknown } | undefined;
  if (node.type === "subgraph") return true;
  // judgment-exempt: this asks "does a model or teammate do the work in this step" (graph versus tool), never "does it
  //   change the outside" — that stays with nodeDeclaresOutwardEffect / nodeCouldHaveActedOutside.
  if (node.type === "agent" || node.type === "action") return !mcp || mcp.catalogId === "one-team";
  return false;
}

export type GraphPurpose = "workflow" | "tool";

/** "tool": an input-triggered graph with no step where a model or teammate works. A scheduled graph is recurring by time. */
export function graphPurpose(graph: Pick<WorkflowGraph, "nodes">, triggerKind: "schedule" | "input" | "manual" | string): GraphPurpose {
  if (triggerKind === "schedule" || triggerKind === "cron") return "workflow";
  return (graph.nodes ?? []).some(node => node.type !== "trigger" && graphNodeOrchestrates(node)) ? "workflow" : "tool";
}
