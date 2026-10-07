import type { RuntimeSelection, WorkflowNode } from "./types";
import { isRuntimeKind } from "./runtime-kinds";

/** A node may choose a runtime kind, not transplant another kind's exact pin. */
export function runtimeSelectionForGraphNode(
  node: Pick<WorkflowNode, "config">,
  base: RuntimeSelection | undefined,
): RuntimeSelection | undefined {
  const value = node.config?.runtime;
  const declared = typeof value === "string" ? value.trim() : "";
  if (!isRuntimeKind(declared) || base?.kind === declared) return base;
  return { kind: declared, role: "worker" };
}
