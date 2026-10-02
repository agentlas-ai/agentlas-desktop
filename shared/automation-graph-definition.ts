import type { Automation, WorkflowGraph } from "./types";

/** The compiler inputs are data, not authority to alter a saved automation. */
export type AutomationGraphSource = Pick<Automation,
  "scheduleHuman" | "promptTemplate" | "targetType" | "targetId" | "targetVersion"
> & { graph?: WorkflowGraph | null };

/**
 * Compatibility compilation only: a prompt-only automation is one executable
 * step. Keep this shape byte-equivalent to the historical host compiler because
 * its digest binds existing occurrence checkpoints and reconciliation receipts.
 * Never infer branches, permission, workspace or new scheduling from prose.
 */
export function synthesizeLegacyGraph(automation: AutomationGraphSource): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      {
        id: "n0",
        type: "trigger",
        position: { x: 0, y: 120 },
        config: { schedule: automation.scheduleHuman },
        label: "Trigger",
      },
      {
        id: "n1",
        type: "agent",
        position: { x: 280, y: 120 },
        config: {
          ref: automation.targetId,
          targetType: automation.targetType,
          prompt: automation.promptTemplate,
          ...(automation.targetType === "hub" && automation.targetVersion
            ? { targetVersion: automation.targetVersion }
            : {}),
        },
        label: automation.targetType === "firm" ? "Firm" : automation.targetType === "hub" ? "Hub Agent" : "Agent",
      },
    ],
    edges: [{ id: "e0-1", source: "n0", target: "n1" }],
  };
}

/** Every graph consumer sees the same definition without rewriting stored rows. */
export function resolveAutomationGraph(automation: AutomationGraphSource): WorkflowGraph {
  return automation.graph?.nodes.length ? automation.graph : synthesizeLegacyGraph(automation);
}

/** A routine tool-only success returns data to One; it does not need a second
 * hidden model to reflect on the same successful collection. Failures retain
 * the existing repair path, and reasoning/evaluation/subgraphs opt out. */
export function nativeGraphSuccessNeedsReflection(graph: WorkflowGraph | null | undefined, successful: boolean): boolean {
  if (!successful || !graph?.nodes.some(node => Boolean(node.config?.mcpCall))) return true;
  return !graph.nodes.every(node => ["trigger", "condition", "transform", "code", "tool"].includes(node.type)
    || (["agent", "action"].includes(node.type) && Boolean(node.config?.mcpCall))
    || (node.type === "output" && node.config?.effect === "read"));
}

/** Editor-only scheduling metadata must not change the historical run digest. */
export function resolveAutomationGraphForEditing(
  automation: AutomationGraphSource & Pick<Automation, "scheduleSpec">,
): WorkflowGraph {
  const graph = resolveAutomationGraph(automation);
  if (automation.graph?.nodes.length || !automation.scheduleSpec) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((node) => node.type === "trigger"
      ? { ...node, config: { ...node.config, scheduleSpec: automation.scheduleSpec } }
      : node),
  };
}

export interface AutomationGraphDefinition {
  schemaVersion: "agentlas.automation-graph-definition.v1";
  automationId: string;
  /** Host-computed definition revision; never accepted as a caller's new value. */
  definitionRevision: string;
  /** Versioned cache identity; raw revisions remain mutation preconditions. */
  cacheKey: string;
  source: "stored-graph" | "legacy-prompt";
  nodeCount: number;
  executableNodeCount: number;
  edgeCount: number;
  unchanged: boolean;
  /** Omitted for a matching revision: cached callers need no repeated prompts. */
  graph?: WorkflowGraph;
}

/**
 * Read protocol for model/tool clients. The host checks origin and computes the
 * authoritative revision before calling this pure projection. An unchanged
 * response contains only the exact reference and topology counts; callers fetch
 * the definition again when the host revision changes. No durable cache or DB
 * migration can mutate running instances, scheduler cursors or workspace intent.
 */
export function readAutomationGraphDefinition(
  automation: AutomationGraphSource & Pick<Automation, "id">,
  definitionRevision: string,
  knownCacheKey?: string,
): AutomationGraphDefinition {
  if (!automation.id || !definitionRevision) throw new Error("automation_graph_definition_identity_required");
  const stored = automation.graph?.nodes.length ? automation.graph : null;
  const schemaVersion = "agentlas.automation-graph-definition.v1" as const;
  const cacheKey = `${schemaVersion}:${definitionRevision}`;
  const unchanged = knownCacheKey === cacheKey;
  return {
    schemaVersion,
    automationId: automation.id,
    definitionRevision,
    cacheKey,
    source: stored ? "stored-graph" : "legacy-prompt",
    nodeCount: stored?.nodes.length ?? 2,
    executableNodeCount: stored?.nodes.filter((node) => node.type !== "trigger" && node.type !== "tool").length ?? 1,
    edgeCount: stored?.edges.length ?? 1,
    unchanged,
    ...(!unchanged ? { graph: resolveAutomationGraph(automation) } : {}),
  };
}
