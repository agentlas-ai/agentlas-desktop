// The single definition of the graph execution digest.
//
// This value decides whether a paused graph run may resume: the runner records
// it when the run starts, and reconciliation compares it before resuming. The
// two used to hold byte-identical private copies, so adding a field to one and
// not the other would have made every in-flight resume fail as graph drift
// while both files still "looked" correct. There is one definition now; both
// call sites import it.
//
// Changing what goes into the digest invalidates every checkpoint recorded by
// an older build. That is the intended behaviour — a run must not resume into a
// different graph — but it means a change here is a breaking change, not a
// refactor.

import { createHash } from "node:crypto";

import type { Automation, WorkflowGraph } from "./types";

/** Sorts object keys recursively so the same content always serializes the same way. */
export function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  return value;
}

export function sha256Value(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest("hex")}`;
}

export function graphExecutionDigest(automation: Automation, graph: WorkflowGraph): string {
  return sha256Value({
    graph,
    targetType: automation.targetType,
    targetId: automation.targetId,
    targetVersion: automation.targetVersion ?? null,
    promptTemplate: automation.promptTemplate,
    executionPermission: automation.executionPermission ?? "write",
    toolMode: automation.toolMode ?? "auto",
    hubMode: automation.hubMode ?? "hub-allowed",
    runtimeSelection: automation.runtimeSelection ?? null,
  });
}
