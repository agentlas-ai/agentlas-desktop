import type { OneHarnessResult, OneArtifactSelection } from "@shared/one-harness";
import type { OneTaskProjection } from "./one-task-adapter";

/** Presentation adapter only: all authority and completion evidence come from Main. */
export function personalOneResultProjection(result: OneHarnessResult): OneTaskProjection {
  const value = result.task.status === "running" ? "working" : result.task.status === "waiting-decision" ? "decision_required"
    : result.task.status === "completed" ? "completed" : result.task.status === "failed" ? "failed"
    : result.task.status === "cancelled" || result.task.status === "archived" ? "stopped" : "waiting";
  return {
    contractVersion: "1.0.0", taskId: result.taskId, canonicalVersion: result.task.version,
    oneId: result.oneId, projectionSurface: "one", projectionMode: "detailed",
    display: { title: result.task.title, summary: result.surface?.summary ?? "" },
    status: { value, source: "authoritative_event", asOf: result.observedAt },
    sync: { connection: result.state.freshness === "current" ? "online" : "degraded", lastSyncedAt: result.observedAt,
      authoritativeHostRef: result.scope.authorityRef, executionAuthorityAvailable: result.scope.authorization === "local-owner",
      mutationMode: result.state.freshness === "current" && result.scope.authorization === "local-owner" ? "direct" : "read_only", queuedOperationCount: 0 },
    truth: { mayStartExecution: false, mayClaimNewCompletion: result.state.result === "ready" && result.state.effect === "settled" && result.state.freshness === "current" },
    references: { manifestId: result.surface?.manifestId, decisionIds: [], artifactIds: result.artifacts.map(item => item.artifactRef), receiptIds: result.receipt ? [result.receipt.runId] : [] },
    availableActions: [], pendingOperations: [], canonicalStatus: result.task.status,
    chatId: result.task.originChatId, chat: null, latestReceipt: result.receipt,
  };
}

export function samePersonalOneResult(a: OneHarnessResult, b: OneHarnessResult): boolean {
  return a.oneId === b.oneId && a.taskId === b.taskId && a.runId === b.runId && a.revision === b.revision;
}

/** DOM selection is evidence only. Main still validates task, revision and block IDs. */
export function personalOneTextSelection(root: HTMLElement, selection: Selection | null): OneArtifactSelection | null {
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode
    || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  const text = selection.toString().trim().slice(0, 4_000);
  if (!text) return null;
  const element = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode.parentElement;
  const blockId = element?.closest<HTMLElement>("[data-semantic-id]")?.dataset.semanticId;
  return { kind: "text", text, ...(blockId ? { blockId } : {}) };
}

/** Window width is not a maximum. Reflow at any size without replacing the mounted task. */
export function personalOnePanelMaximum(viewportWidth: number, detached: boolean): number {
  const width = Math.max(280, Number.isFinite(viewportWidth) ? viewportWidth : 380);
  return width < 860 ? width : Math.max(280, width - (detached ? 0 : 218) - 360);
}
