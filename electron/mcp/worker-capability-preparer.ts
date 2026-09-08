import { createHash } from "node:crypto";
import type { McpNeedCandidate, ResolvedMcpNeeds } from "../mcp-tools/need-resolver";
import type { ActiveGoalToolScope } from "../mcp-tools/auto-select";
import { WorkerCapabilityError, type PrepareWorkerCapabilities, type WorkerCapabilityInput, type WorkerCapabilityLease } from "./worker-capabilities";

export interface WorkerCapabilityInventory {
  fingerprint: string;
  candidates: McpNeedCandidate[];
}
interface PreparationDependencies {
  scope: ActiveGoalToolScope;
  cwd?: string;
  baselineIds: readonly string[];
  readScope: () => ActiveGoalToolScope | null;
  inventory: () => WorkerCapabilityInventory;
  assertParentCurrent: () => void;
  select: (input: { task: string; candidates: McpNeedCandidate[]; goal: { objective: string; acceptanceCriteria: readonly string[] }; signal?: AbortSignal; timeoutMs: number }) => Promise<ResolvedMcpNeeds>;
  materialize: (input: WorkerCapabilityInput, ids: string[], generation: string) => Promise<WorkerCapabilityLease>;
  receipt: (value: Record<string, unknown>) => void;
}
// One bounded asynchronous pool attempt accommodates measured cold CLI judgments.
export const WORKER_CAPABILITY_SELECTION_TIMEOUT_MS = 90_000;
const permissionRank = { read: 0, write: 1, full: 2 } as const;
const scopeKey = (scope: ActiveGoalToolScope) => JSON.stringify([scope.goalId, scope.revision, scope.permission, scope.objective, scope.acceptanceCriteria]);

/** Main-only per-dispatch preparation. A packet requests capabilities, never authority. */
export function createWorkerCapabilityPreparer(deps: PreparationDependencies): PrepareWorkerCapabilities {
  const expectedScope = scopeKey(deps.scope);
  const selectionMemo = new Map<string, string[]>();
  const emit = (receipt: Record<string, unknown>) => { try { deps.receipt(receipt); } catch { /* Receipt failure cannot widen authority. */ } };
  const prepare: PrepareWorkerCapabilities = async (input) => {
    const generation = createHash("sha256").update(JSON.stringify([input.workerId, input.attemptId, input.runtime.kind,
      input.runtime.backend, input.runtime.model, input.permission, input.cwd])).digest("hex");
    let inventory: WorkerCapabilityInventory | undefined;
    const assertCurrent = () => {
      deps.assertParentCurrent();
      const scope = deps.readScope();
      if (input.signal?.aborted || !scope || scopeKey(scope) !== expectedScope
        || !input.permission || permissionRank[input.permission] > permissionRank[deps.scope.permission]
        || input.cwd !== deps.cwd
        || (inventory && deps.inventory().fingerprint !== inventory.fingerprint)) {
        throw new WorkerCapabilityError("worker-capability-scope-changed");
      }
    };
    const base = { schemaVersion: 1, workerId: input.workerId, attemptId: input.attemptId, generation,
      runtimeKind: input.runtime.kind, permission: input.permission, ceiling: input.ceiling };
    assertCurrent();
    // Prepared packages and Agent Apps own an exact grant. Their packet cannot
    // add a host tool, even when a later task would benefit from that tool.
    if (input.ceiling !== "host") {
      emit({ ...base, status: "retained", reasonCode: "prepared-capability-ceiling" });
      return { runner: {}, assertCurrent, release() {} };
    }
    inventory = deps.inventory();
    const available = new Set(inventory.candidates.map((candidate) => candidate.id));
    if (deps.baselineIds.some((id) => !available.has(id))) {
      throw new WorkerCapabilityError("worker-capability-inventory-changed");
    }
    const task = JSON.stringify({ brief: input.task.brief, doneWhen: input.task.doneWhen,
      expectedOutput: input.task.expectedOutput, constraints: input.task.constraints,
      alreadyAvailableToolIds: deps.baselineIds,
      instruction: "Select only capabilities genuinely required for this worker packet and its completion evidence. Existing tools remain available; do not pad the selection." });
    const memoKey = createHash("sha256").update(JSON.stringify([expectedScope, inventory.fingerprint,
      input.permission, input.cwd, task])).digest("hex");
    const cachedIds = selectionMemo.get(memoKey);
    let needs: ResolvedMcpNeeds;
    if (cachedIds) {
      needs = { decided: true, needed: [...cachedIds], reason: "same-scope successful selection", omitted: [] };
      emit({ ...base, status: "selection-reused", evidenceType: "capability-binding-only" });
    } else {
      emit({ ...base, status: "selecting", evidenceType: "capability-binding-only" });
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        const interrupted = new Promise<never>((_resolve, reject) => {
          onAbort = () => { controller.abort(); reject(new WorkerCapabilityError("worker-capability-selection-cancelled")); };
          input.signal?.addEventListener("abort", onAbort, { once: true });
          if (input.signal?.aborted) onAbort();
          timer = setTimeout(() => { controller.abort(); reject(new WorkerCapabilityError("worker-capability-selection-timeout")); },
            WORKER_CAPABILITY_SELECTION_TIMEOUT_MS);
        });
        needs = await Promise.race([deps.select({ task, candidates: inventory.candidates,
          goal: { objective: deps.scope.objective ?? "", acceptanceCriteria: deps.scope.acceptanceCriteria ?? [] },
          signal: controller.signal, timeoutMs: WORKER_CAPABILITY_SELECTION_TIMEOUT_MS }), interrupted]);
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) input.signal?.removeEventListener("abort", onAbort);
      }
    }
    assertCurrent();
    if (!needs.decided) {
      emit({ ...base, status: "unavailable", reasonCode: "worker-capability-selection-unavailable",
        failureKind: needs.failureKind ?? null, decisionFailure: needs.decisionFailure ?? null,
        attempts: needs.attempts?.map((attempt) => ({ outcome: attempt.outcome, failureKind: attempt.failureKind,
          elapsedMs: attempt.elapsedMs, runtimeKind: attempt.runtimeReceipt.selection.kind })) ?? [] });
      throw new WorkerCapabilityError("worker-capability-selection-unavailable");
    }
    if (needs.needed.some((id) => !available.has(id))) throw new WorkerCapabilityError("worker-capability-selection-outside-ceiling");
    // Cache only a successful in-ceiling judgment, never a failure or a grant.
    // Every actual attempt still gets fresh transport and current-scope checks.
    selectionMemo.set(memoKey, [...needs.needed]);
    while (selectionMemo.size > 64) selectionMemo.delete(selectionMemo.keys().next().value!);
    const selectedIds = [...new Set([...deps.baselineIds, ...needs.needed])];
    // A complete empty judgment is legitimate; it must not fabricate an MCP grant.
    if (selectedIds.length === 0) {
      emit({ ...base, status: "retained", reasonCode: "no-additional-capability-selected", selectedIds: [] });
      return { runner: {}, assertCurrent, release() {} };
    }
    const lease = await deps.materialize(input, selectedIds, generation);
    try { assertCurrent(); lease.assertCurrent(); }
    catch (error) { await lease.release(); throw error; }
    emit({ ...base, status: "prepared", selectedIds,
      addedIds: selectedIds.filter((id) => !deps.baselineIds.includes(id)), evidenceType: "capability-binding-only" });
    return { runner: lease.runner, assertCurrent() { assertCurrent(); lease.assertCurrent(); }, release: lease.release };
  };
  return async (input) => {
    try { return await prepare(input); }
    catch (error) {
      const failure = error instanceof WorkerCapabilityError ? error : new WorkerCapabilityError("worker-capability-preparation-unavailable");
      emit({ schemaVersion: 1, workerId: input.workerId, attemptId: input.attemptId,
        status: "unavailable", reasonCode: failure.code, evidenceType: "capability-binding-only" });
      throw failure;
    }
  };
}
