import { createHash } from "node:crypto";
import type { LongRunRuntimeSelection, LongRunWorkspaceBinding } from "../../shared/long-run";
import type { McpInvocationEvent, RuntimeSelection } from "../../shared/types";
import {
  addLongRunTask,
  bindLongRunWorker,
  enqueueLongRunMessage,
  settleLongRunMessage,
  settleLongRunWorkerAttempt,
  startLongRunWorkerAttempt,
} from "../store/long-runs";
import { resolveDesktopRuntimeAdapter } from "./runtime-adapters";

interface ProjectedWorker {
  workerId: string;
  attemptId: string;
  settled: boolean;
}

export interface DesktopInvocationProjectionInput {
  longRunId: string;
  taskId: string;
  invocationRunId: string;
  controllerAgentId: string | null;
  workspaceBinding: LongRunWorkspaceBinding;
  permissionProfile: string;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function longRunSelection(selection: RuntimeSelection): LongRunRuntimeSelection {
  const adapter = resolveDesktopRuntimeAdapter(selection);
  const source = selection.source === "cloud" || selection.source === "hub" || selection.source === "builtin"
    ? selection.source
    : "local";
  return {
    kind: selection.kind,
    backend: selection.backend ?? null,
    model: selection.model ?? null,
    effort: selection.effort ?? null,
    source,
    capabilityDescriptorId: adapter.id,
  };
}

function eventAgentId(event: McpInvocationEvent): string | null {
  const value = event.runtimeAgentId ?? event.agentId ?? event.nodeId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function runtimeSelectionFromEvent(event: McpInvocationEvent): RuntimeSelection | null {
  if (event.runtimeSelection) return event.runtimeSelection;
  const kind = event.agentLifecycle?.runtime;
  if (!kind) return null;
  try {
    const selection = { kind: kind as RuntimeSelection["kind"] };
    resolveDesktopRuntimeAdapter(selection);
    return selection;
  } catch {
    return null;
  }
}

/**
 * Projects already-running One/Work orchestration into the provider-neutral
 * long-run worker tree. It does not invent or dispatch workers; it records only
 * runtime selections, lifecycle facts, and typed handoffs emitted by Main.
 */
export class DesktopLongRunInvocationProjection {
  private controllerWorkerId: string | null = null;
  private readonly workersByAgentId = new Map<string, ProjectedWorker>();
  private readonly messageIds = new Set<string>();

  constructor(private readonly input: DesktopInvocationProjectionInput) {}

  bindController(workerId: string, controllerAgentId = this.input.controllerAgentId): void {
    this.controllerWorkerId = workerId;
    if (controllerAgentId) {
      this.workersByAgentId.set(controllerAgentId, { workerId, attemptId: "", settled: false });
    }
  }

  private ensureWorker(agentId: string, selection: RuntimeSelection | null): ProjectedWorker | null {
    const existing = this.workersByAgentId.get(agentId);
    if (existing) return existing;
    if (!selection || !this.controllerWorkerId) return null;
    const workerId = stableId("worker", `${this.input.longRunId}:${this.input.invocationRunId}:${agentId}`);
    const taskId = stableId("task", `${this.input.longRunId}:${this.input.invocationRunId}:${agentId}`);
    const resolved = longRunSelection(selection);
    try {
      addLongRunTask({
        runId: this.input.longRunId,
        id: taskId,
        parentTaskId: this.input.taskId,
        title: `Specialist ${agentId}`,
        objective: `Execute the assigned specialist packet for invocation ${this.input.invocationRunId}.`,
      });
      bindLongRunWorker({
        workerId,
        runId: this.input.longRunId,
        parentWorkerId: this.controllerWorkerId,
        taskId,
        role: "specialist",
        agentDefinitionId: agentId,
        agentRelease: null,
        runtimeSelection: resolved,
        workspaceBinding: this.input.workspaceBinding,
        permissionProfile: this.input.permissionProfile,
        state: "idle",
      });
      const attempt = startLongRunWorkerAttempt({
        runId: this.input.longRunId,
        workerId,
        taskId,
        invocationRunId: this.input.invocationRunId,
        runtimeSelection: resolved,
      });
      const projected = { workerId, attemptId: attempt.attemptId, settled: false };
      this.workersByAgentId.set(agentId, projected);
      return projected;
    } catch (error) {
      // Duplicate lifecycle events may arrive from both the runner and the
      // resident-process registry. A genuine schema/budget error remains
      // visible to the caller instead of silently inventing a worker.
      if (error instanceof Error && /UNIQUE constraint failed: long_run_workers\.id/.test(error.message)) {
        return this.workersByAgentId.get(agentId) ?? null;
      }
      throw error;
    }
  }

  observe(event: McpInvocationEvent): void {
    if (!this.controllerWorkerId) return;
    const agentId = eventAgentId(event);
    const selection = runtimeSelectionFromEvent(event);
    const worker = agentId ? this.ensureWorker(agentId, selection) : null;

    if (worker && worker.attemptId && !worker.settled) {
      const lifecycle = event.agentLifecycle;
      if (event.kind === "error" || lifecycle?.state === "failed") {
        settleLongRunWorkerAttempt({
          attemptId: worker.attemptId,
          state: "failed",
          sideEffectState: "uncertain",
          errorCode: event.error?.code ?? lifecycle?.reason ?? "worker_failed",
          errorMessage: event.error?.message ?? null,
        });
        worker.settled = true;
      } else if (event.done === true || lifecycle?.state === "idle" || lifecycle?.reason === "turn-complete") {
        settleLongRunWorkerAttempt({ attemptId: worker.attemptId, state: "completed", sideEffectState: "committed" });
        worker.settled = true;
      } else if (lifecycle?.state === "closed") {
        const normal = ["reaped", "evicted", "turn-complete"].includes(lifecycle.reason);
        settleLongRunWorkerAttempt({
          attemptId: worker.attemptId,
          state: normal ? "completed" : "interrupted",
          sideEffectState: normal ? "committed" : "uncertain",
          ...(!normal ? { errorCode: lifecycle.reason } : {}),
        });
        worker.settled = true;
      }
    }

    const message = event.agentMessage;
    if (!message || this.messageIds.has(message.messageId)) return;
    const from = this.workersByAgentId.get(message.fromAgentId);
    const to = this.workersByAgentId.get(message.toAgentId);
    if (!from || !to) return;
    const messageId = stableId("message", `${this.input.longRunId}:${message.messageId}`);
    enqueueLongRunMessage({
      messageId,
      runId: this.input.longRunId,
      fromWorkerId: from.workerId,
      toWorkerId: to.workerId,
      kind: message.direction === "orchestrator-to-worker" ? "task" : "result",
      bodyRef: `invocation-event:${this.input.invocationRunId}:agent-message:${message.messageId}`,
    });
    settleLongRunMessage({ messageId, state: "delivered" });
    settleLongRunMessage({ messageId, state: "acknowledged" });
    this.messageIds.add(message.messageId);
  }

  settleOpenWorkers(completed: boolean): void {
    for (const worker of this.workersByAgentId.values()) {
      if (!worker.attemptId || worker.settled) continue;
      settleLongRunWorkerAttempt({
        attemptId: worker.attemptId,
        state: completed ? "completed" : "interrupted",
        sideEffectState: completed ? "committed" : "uncertain",
        ...(!completed ? { errorCode: "parent_invocation_interrupted" } : {}),
      });
      worker.settled = true;
    }
  }
}
