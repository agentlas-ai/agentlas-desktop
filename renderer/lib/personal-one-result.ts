import type { OneHarnessResult, OneArtifactSelection, OneHarnessResultRequest } from "@shared/one-harness";
import type { CanonicalTask, CanonicalTaskResultAcceptance } from "@shared/types";
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

/** The owner's explicit review uses the existing exact Task acceptance contract. Main remains authoritative. */
export function personalOneResultAcceptance(result: OneHarnessResult, currentRunId: string | null): CanonicalTaskResultAcceptance | null {
  const { task, receipt, scope, state } = result;
  if (!currentRunId || result.runId !== currentRunId || task.id !== result.taskId
    || scope.oneIdentityRef !== result.oneId || scope.taskId !== task.id || scope.runId !== result.runId || scope.surface !== "work"
    || scope.authorization !== "local-owner" || state.freshness !== "current" || state.process !== "settled"
    || state.effect !== "settled" || result.effect.state !== "settled" || result.effect.pendingEffectRefs.length > 0
    || !["ready", "partial"].includes(state.result) || task.archivedAt || task.status !== "partial"
    || !Number.isSafeInteger(task.version) || task.version <= 0 || !task.originChatId
    || receipt?.status !== "completed" || receipt.runId !== result.runId || receipt.chatId !== task.originChatId) return null;
  return { taskId: task.id, expectedVersion: task.version, expectedRunId: receipt.runId };
}

/** Re-read the reviewed revision before sending the owner's exact acceptance. A lost reply is never retried here. */
export async function acceptPersonalOneResultReview(displayed: OneHarnessResult, currentRunId: string | null, ports: {
  getResult(input: OneHarnessResultRequest): Promise<OneHarnessResult>;
  acceptResult(input: CanonicalTaskResultAcceptance): Promise<CanonicalTask>;
  stillCurrent(): boolean;
}): Promise<{ state: "accepted" } | { state: "changed"; result: OneHarnessResult } | { state: "inactive" }> {
  const input = personalOneResultAcceptance(displayed, currentRunId);
  if (!input || !ports.stillCurrent()) return { state: "inactive" };
  const fresh = await ports.getResult({ oneId: displayed.oneId, taskId: displayed.taskId, runId: displayed.runId, expectedVersion: displayed.controlVersion });
  if (!ports.stillCurrent()) return { state: "inactive" };
  const exact = personalOneResultAcceptance(fresh, currentRunId);
  if (fresh.oneId !== displayed.oneId || fresh.taskId !== displayed.taskId || fresh.task.id !== displayed.task.id || fresh.runId !== displayed.runId) throw new Error("result_binding_mismatch");
  if (!exact || !samePersonalOneResult(displayed, fresh) || exact.expectedVersion !== input.expectedVersion) return { state: "changed", result: fresh };
  const accepted = await ports.acceptResult(input);
  if (accepted.id !== input.taskId || accepted.originChatId !== displayed.task.originChatId || accepted.status !== "completed"
    || !Number.isSafeInteger(accepted.version) || accepted.version <= input.expectedVersion) throw new Error("result_acceptance_unconfirmed");
  return { state: "accepted" };
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
