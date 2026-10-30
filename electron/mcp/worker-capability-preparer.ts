import { createHash } from "node:crypto";
import type { McpNeedCandidate, ResolvedMcpNeeds } from "../mcp-tools/need-resolver";
import type { ActiveGoalToolScope } from "../mcp-tools/auto-select";
import { WorkerCapabilityError, type PrepareWorkerCapabilities, type WorkerCapabilityInput, type WorkerCapabilityLease } from "./worker-capabilities";
import { resolveHostDelegatedPermission } from "./delegated-authority";

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
  /**
   * The worker runs with fewer tools than were asked for (a tool the task named could not attach: not connected, or its key is
   * missing). Telemetry for the owner's transcript only; it cannot grant or revoke anything.
   */
  degraded?: (info: { workerId: string; attemptId: string; agentName: string;
    tools: ReadonlyArray<{ id: string; name: string; needsCredential: boolean }> }) => void;
}
export class WorkerCapabilityMaterializationError extends WorkerCapabilityError {
  constructor(readonly unavailableIds: readonly string[]) {
    super("worker-capability-credential-or-server-unavailable");
  }
}
/**
 * The owner changed the installed MCP list while this worker was being prepared. Same public code as every other change of the
 * boundary; the distinct class only lets the preparer read the list once more (the hard checks run again on that read).
 */
class WorkerCapabilityInventoryDrift extends WorkerCapabilityError {
  constructor() { super("worker-capability-scope-changed"); }
}
// One bounded asynchronous pool attempt accommodates measured cold CLI judgments.
export const WORKER_CAPABILITY_SELECTION_TIMEOUT_MS = 300_000;
const permissionRank = { read: 0, write: 1, full: 2 } as const;
const scopeKey = (scope: ActiveGoalToolScope) => JSON.stringify([scope.goalId, scope.revision, scope.permission, scope.objective, scope.acceptanceCriteria]);

/**
 * Main-only per-dispatch preparation. A packet requests capabilities, never authority.
 *
 * Choosing EXTRA tools for a worker is an optional helper step, never a condition of the worker running. What a worker is
 * allowed to use is bounded by the parent run's own set (`baselineIds`) plus what the judge adds from the installed inventory:
 * every fallback below only ever REMOVES tools from that bound, so none of them can widen authority.
 *  - the judge cannot answer (rate limit of the judge's own runtime, timeout, refusal, junk, an exception, nothing on the shelf):
 *    the worker runs with the parent's set, like the parent turn does (receipt reasonCode ...-baseline-only);
 *  - the judge names something outside the inventory: that id is dropped, the rest stands;
 *  - a baseline tool vanished from the inventory, or a tool cannot attach (not connected, key missing): the judge is asked once
 *    more without the unattachable ones, then the worker runs with the tools that did attach and the owner is told which tool it
 *    is missing (`degraded`), so a missing credential is never silent;
 *  - the owner's Stop stays a cancel (worker-capability-selection-cancelled), and a changed Goal revision, permission or folder
 *    still refuses (worker-capability-scope-changed).
 */
export function createWorkerCapabilityPreparer(deps: PreparationDependencies): PrepareWorkerCapabilities {
  const expectedScope = scopeKey(deps.scope);
  const selectionMemo = new Map<string, string[]>();
  const announced = new Set<string>();
  const emit = (receipt: Record<string, unknown>) => { try { deps.receipt(receipt); } catch { /* Receipt failure cannot widen authority. */ } };
  const prepare = async (input: WorkerCapabilityInput, excludedIds: readonly string[] = [], reselection = false): Promise<WorkerCapabilityLease> => {
    const generation = createHash("sha256").update(JSON.stringify([input.workerId, input.attemptId, input.runtime.kind,
      input.runtime.backend, input.runtime.model, input.permission, input.cwd])).digest("hex");
    let inventory: WorkerCapabilityInventory | undefined;
    const assertCurrent = () => {
      deps.assertParentCurrent();
      const scope = deps.readScope();
      let permissionAllowed = Boolean(input.permission && permissionRank[input.permission] <= permissionRank[deps.scope.permission]);
      if (!permissionAllowed && input.permission && input.delegatedAuthority) {
        const authority = input.delegatedAuthority;
        permissionAllowed = resolveHostDelegatedPermission(authority.grant, { runId: authority.runId,
          scopeKey: authority.scopeKey, workspace: input.cwd, permission: input.permission,
          fallbackPermission: deps.scope.permission }) === input.permission;
      }
      if (input.signal?.aborted || !scope || scopeKey(scope) !== expectedScope
        || !permissionAllowed
        || input.cwd !== deps.cwd) {
        throw new WorkerCapabilityError("worker-capability-scope-changed");
      }
      if (inventory && deps.inventory().fingerprint !== inventory.fingerprint) throw new WorkerCapabilityInventoryDrift();
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
    const known = new Map(inventory.candidates.map((candidate) => [candidate.id, candidate] as const));
    // A baseline tool the owner disconnected or removed since the parent run started is simply not part of this worker's set.
    const baselineIds = deps.baselineIds.filter((id) => known.has(id));
    const lostBaselineIds = deps.baselineIds.filter((id) => !known.has(id));
    // Composition order: fixed → variable (docs/PROMPT-COMPOSITION-POLICY.md, ledger desktop.mcp.worker-capability.selection-task).
    const task = JSON.stringify({
      instruction: "Select only capabilities genuinely required for this worker packet and its completion evidence. Existing tools remain available; do not pad the selection.",
      alreadyAvailableToolIds: baselineIds,
      brief: input.task.brief, doneWhen: input.task.doneWhen,
      expectedOutput: input.task.expectedOutput, constraints: input.task.constraints });
    const memoKey = createHash("sha256").update(JSON.stringify([expectedScope, inventory.fingerprint,
      input.permission, input.cwd, task])).digest("hex");
    const cachedIds = reselection ? undefined : selectionMemo.get(memoKey);
    let needs: ResolvedMcpNeeds | undefined;
    // Why no judgment came back (typed, for the receipt): the judge's own failure, a timeout, or an exception inside the helper.
    let selectionFailure: Record<string, unknown> | undefined;
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
        needs = await Promise.race([deps.select({ task, candidates: inventory.candidates.filter((candidate) => !excludedIds.includes(candidate.id)),
          goal: { objective: deps.scope.objective ?? "", acceptanceCriteria: deps.scope.acceptanceCriteria ?? [] },
          signal: controller.signal, timeoutMs: WORKER_CAPABILITY_SELECTION_TIMEOUT_MS }), interrupted]);
      } catch (error) {
        // The owner's Stop is a cancel, not a failure of the helper.
        if (input.signal?.aborted || (error instanceof WorkerCapabilityError && error.code === "worker-capability-selection-cancelled")) {
          throw error instanceof WorkerCapabilityError ? error : new WorkerCapabilityError("worker-capability-selection-cancelled");
        }
        selectionFailure = error instanceof WorkerCapabilityError && error.code === "worker-capability-selection-timeout"
          ? { failureKind: "timeout", decisionFailure: "timeout" }
          : { failureKind: "judge-error", decisionFailure: "unavailable" };
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) input.signal?.removeEventListener("abort", onAbort);
      }
    }
    assertCurrent();
    // Tools the worker could not get, told once per distinct set to the owner (a missing key is never silent).
    const announce = (ids: readonly string[]) => {
      const unique = [...new Set(ids)];
      const key = [...unique].sort().join("\u0000");
      if (unique.length === 0 || announced.has(key)) return;
      announced.add(key);
      try {
        deps.degraded?.({ workerId: input.workerId, attemptId: input.attemptId, agentName: input.agentName,
          tools: unique.map((id) => ({ id, name: known.get(id)?.name ?? id, needsCredential: known.get(id)?.needsCredential === true })) });
      } catch { /* The notice cannot grant or revoke tools. */ }
    };
    /** One materialization; when only some ids cannot attach, one more with the rest. Only ever removes tools. */
    const materializeBounded = async (wanted: string[]): Promise<{ lease: WorkerCapabilityLease; ids: string[]; dropped: string[] }> => {
      try { return { lease: await deps.materialize(input, wanted, generation), ids: wanted, dropped: [] }; }
      catch (error) {
        if (!(error instanceof WorkerCapabilityMaterializationError)) throw error;
        assertCurrent();
        const keep = wanted.filter((id) => !error.unavailableIds.includes(id));
        if (keep.length === 0 || keep.length === wanted.length) throw error;
        emit({ ...base, status: "degrading", reasonCode: "worker-capability-materialization-degraded",
          unavailableCount: wanted.length - keep.length, evidenceType: "capability-binding-only" });
        return { lease: await deps.materialize(input, keep, generation), ids: keep, dropped: wanted.filter((id) => !keep.includes(id)) };
      }
    };
    const leaseOf = (lease: WorkerCapabilityLease): WorkerCapabilityLease => ({ runner: lease.runner,
      assertCurrent() { assertCurrent(); lease.assertCurrent(); }, release: lease.release });
    // The worker runs with the parent's own set. No qualified judge (an unmeasured or failing local model pin, a runtime that
    // cannot judge without tools, and no measured pool runtime), a judge that was asked and failed (its own runtime rate-limited,
    // a timeout, a refusal, junk), or an empty shelf is a fact about a helper, not about the worker: the judge must never block the run.
    const retainBaseline = async (reasonCode: string, extra: Record<string, unknown>): Promise<WorkerCapabilityLease> => {
      emit({ ...base, status: "retained", reasonCode, selectedIds: [...baselineIds], ...extra });
      if (baselineIds.length === 0) {
        // The parent had tools and none of them is installed any more: there is no set to run with that the owner has not removed.
        if (lostBaselineIds.length > 0) throw new WorkerCapabilityError("worker-capability-inventory-changed");
        return { runner: {}, assertCurrent, release() {} };
      }
      const { lease, dropped } = await materializeBounded([...baselineIds]);
      try { assertCurrent(); lease.assertCurrent(); }
      catch (error) { await lease.release(); throw error; }
      announce([...lostBaselineIds, ...dropped]);
      return leaseOf(lease);
    };
    if (!needs || !needs.decided) {
      if (needs?.judgeSkipped === true) return retainBaseline("worker-capability-judge-unqualified-baseline-only", {});
      return retainBaseline("worker-capability-selection-unavailable-baseline-only", {
        failureKind: needs?.failureKind ?? selectionFailure?.failureKind ?? null,
        decisionFailure: needs?.decisionFailure ?? selectionFailure?.decisionFailure ?? null,
        attempts: needs?.attempts?.map((attempt) => ({ outcome: attempt.outcome, failureKind: attempt.failureKind,
          elapsedMs: attempt.elapsedMs, runtimeKind: attempt.runtimeReceipt.selection.kind })) ?? [] });
    }
    // An id outside the inventory (or one just found unattachable) never attaches; the rest of the judgment stands.
    const requested = [...new Set(needs.needed)];
    const wanted = requested.filter((id) => known.has(id) && !excludedIds.includes(id));
    const outsideCeilingCount = requested.length - wanted.length;
    const selectedIds = [...new Set([...baselineIds, ...wanted])];
    // A complete empty judgment is legitimate; it must not fabricate an MCP grant.
    if (selectedIds.length === 0) {
      if (lostBaselineIds.length > 0) throw new WorkerCapabilityError("worker-capability-inventory-changed");
      emit({ ...base, status: "retained", reasonCode: "no-additional-capability-selected", selectedIds: [] });
      return { runner: {}, assertCurrent, release() {} };
    }
    let attached: { lease: WorkerCapabilityLease; ids: string[]; dropped: string[] };
    try { attached = { lease: await deps.materialize(input, selectedIds, generation), ids: selectedIds, dropped: [] }; }
    catch (error) {
      selectionMemo.delete(memoKey);
      if (!(error instanceof WorkerCapabilityMaterializationError)) throw error;
      assertCurrent();
      if (!reselection && error.unavailableIds.length > 0
        && error.unavailableIds.every((id) => selectedIds.includes(id))
        && !error.unavailableIds.some((id) => baselineIds.includes(id))) {
        emit({ ...base, status: "reselecting", reasonCode: "worker-capability-materialization-reselection",
          evidenceType: "capability-binding-only" });
        return prepare(input, error.unavailableIds, true);
      }
      // The judge was already asked once without them (or a baseline tool is the one that cannot attach): run with what attaches.
      const keep = selectedIds.filter((id) => !error.unavailableIds.includes(id));
      if (keep.length === 0 || keep.length === selectedIds.length) throw error;
      emit({ ...base, status: "degrading", reasonCode: "worker-capability-materialization-degraded",
        unavailableCount: selectedIds.length - keep.length, evidenceType: "capability-binding-only" });
      attached = { lease: await deps.materialize(input, keep, generation), ids: keep, dropped: selectedIds.filter((id) => !keep.includes(id)) };
    }
    const { lease, ids, dropped } = attached;
    try { assertCurrent(); lease.assertCurrent(); }
    catch (error) { selectionMemo.delete(memoKey); await lease.release(); throw error; }
    // A selection is reusable only after its transport and scope are validated, and only when it attached whole.
    if (dropped.length === 0) {
      selectionMemo.set(memoKey, [...needs.needed]);
      while (selectionMemo.size > 64) selectionMemo.delete(selectionMemo.keys().next().value!);
    }
    emit({ ...base, status: "prepared", selectedIds: ids,
      addedIds: ids.filter((id) => !baselineIds.includes(id)), evidenceType: "capability-binding-only",
      ...(outsideCeilingCount > 0 ? { outsideCeilingCount } : {}),
      ...(dropped.length > 0 || lostBaselineIds.length > 0 ? { unavailableCount: dropped.length + lostBaselineIds.length } : {}) });
    announce([...lostBaselineIds, ...dropped]);
    return leaseOf(lease);
  };
  return async (input) => {
    try {
      try { return await prepare(input); }
      catch (error) {
        if (!(error instanceof WorkerCapabilityInventoryDrift)) throw error;
        // The owner changed the tool list while this worker was being prepared: read it once more. The hard checks (Stop, Goal
        // revision, permission, folder) run again on that read and still refuse.
        return await prepare(input);
      }
    } catch (error) {
      const failure = error instanceof WorkerCapabilityError ? error : new WorkerCapabilityError("worker-capability-preparation-unavailable",
        "worker-capability-preparation-unavailable", { cause: error, turnDelivery: "not-dispatched" });
      emit({ schemaVersion: 1, workerId: input.workerId, attemptId: input.attemptId,
        status: "unavailable", reasonCode: failure.code, evidenceType: "capability-binding-only" });
      throw failure;
    }
  };
}
