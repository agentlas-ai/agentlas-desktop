import type { WorkflowGraph } from "../../shared/types";

/** The kernel's unknown-outcome codes (workflow/run-graph.ts UNCERTAIN_EFFECT_NOTE_CODES); a gate asserts the two lists are the same. */
const UNCERTAIN_EFFECT_CODES: ReadonlySet<string> = new Set([
  "MUTATION_UNVERIFIED",
  "automation_partial_reconciliation_required",
  "automation_partial_graph_changed",
  "automation_fresh_run_blocked",
]);

/**
 * What a finished run says about the steps whose outside effect stayed unknown, read from the kernel's typed node failures (never from
 * prose). The trigger outbox uses it to close an occurrence by itself: a redelivery that ends with the same held steps as the one
 * before cannot change anything when no model step is among them, because only a step a model runs (agent/action, not a direct tool
 * call or code) reads the uncertain-effect note on a redelivery (workflow/run-graph.ts, unknownOutcomeRetry).
 * Undefined when the run named no held step: the outbox then applies only the delivery cap.
 */
export function unconfirmedEffectFacts(
  nodeFailures: Record<string, unknown> | null | undefined,
  graph: Pick<WorkflowGraph, "nodes"> | null | undefined,
): { signature: string; askableAgain: boolean } | undefined {
  const held: string[] = [];
  let askableAgain = false;
  for (const [nodeId, failure] of Object.entries(nodeFailures ?? {})) {
    const code = failure && typeof failure === "object" ? (failure as { code?: unknown }).code : undefined;
    if (typeof code !== "string" || !UNCERTAIN_EFFECT_CODES.has(code)) continue;
    held.push(`${nodeId}:${code}`);
    const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
    // A node the graph no longer has cannot be proved unable to answer differently.
    if (!node || (["agent", "action"].includes(node.type) && !Object.hasOwn(node.config ?? {}, "mcpCall"))) askableAgain = true;
  }
  return held.length > 0 ? { signature: held.sort().join(","), askableAgain } : undefined;
}
