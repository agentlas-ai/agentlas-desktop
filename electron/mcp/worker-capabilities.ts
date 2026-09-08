import type { RuntimeStatus } from "../../shared/types";
import type { Runner, RunnerRequest } from "../runtime/runner";

export type WorkerCapabilityRunnerFields = Partial<Pick<RunnerRequest,
  "mcpConfigPath" | "mcpAllowedTools" | "mcpCodexConfigArgs" | "env" | "isolatedMcpConfig" | "browserOnly">>;
export interface WorkerCapabilityInput {
  workerId: string;
  attemptId: string;
  agentId?: string;
  agentName: string;
  task: { brief: string; doneWhen: string[]; expectedOutput?: string; constraints?: string[] };
  runtime: RuntimeStatus;
  permission: RunnerRequest["permission"];
  cwd?: string;
  signal?: AbortSignal;
  ceiling: "host" | "prepared" | "agent-app";
}
export interface WorkerCapabilityLease {
  runner: WorkerCapabilityRunnerFields;
  assertCurrent: () => void;
  release: () => void | Promise<void>;
}
export type PrepareWorkerCapabilities = (input: WorkerCapabilityInput) => Promise<WorkerCapabilityLease>;
export class WorkerCapabilityError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "WorkerCapabilityError"; }
}
const RUNNER_KEYS = new Set(["mcpConfigPath", "mcpAllowedTools", "mcpCodexConfigArgs", "env", "isolatedMcpConfig", "browserOnly"]);

/** A lease belongs to one actual runner call, including provider retries. */
export function workerCapabilityRunner(
  prepare: PrepareWorkerCapabilities | undefined,
  input: Omit<WorkerCapabilityInput, "permission" | "cwd" | "signal">,
  runner: Runner,
  evidence: (code: string) => void = () => {},
): Runner {
  if (!prepare) return runner; // Compatibility callers have no authority to claim new capabilities.
  const report = (code: string) => { try { evidence(code); } catch { /* Telemetry cannot grant or revoke tools. */ } };
  return async (request, events) => {
    let lease: WorkerCapabilityLease | undefined;
    let dispatched = false;
    try {
      if (request.signal?.aborted) throw new WorkerCapabilityError("worker_capabilities_cancelled");
      lease = await prepare({ ...input, permission: request.permission, cwd: request.cwd, signal: request.signal });
      if (!lease || typeof lease.assertCurrent !== "function" || typeof lease.release !== "function"
        || !lease.runner || typeof lease.runner !== "object" || Array.isArray(lease.runner)
        || Object.keys(lease.runner).some((key) => !RUNNER_KEYS.has(key))) {
        throw new WorkerCapabilityError("worker_capabilities_invalid_lease");
      }
      if ((request.browserOnly && Object.hasOwn(lease.runner, "browserOnly") && lease.runner.browserOnly !== true)
        || (request.isolatedMcpConfig && Object.hasOwn(lease.runner, "isolatedMcpConfig") && lease.runner.isolatedMcpConfig !== true)) {
        throw new WorkerCapabilityError("worker_capabilities_boundary_widened");
      }
      if (input.ceiling !== "host" && Object.keys(lease.runner).length > 0) {
        throw new WorkerCapabilityError("worker_capabilities_ceiling_not_revalidated");
      }
      if (request.signal?.aborted) throw new WorkerCapabilityError("worker_capabilities_cancelled");
      lease.assertCurrent();
      report(input.ceiling === "host" ? "worker_capabilities_prepared" : "worker_capabilities_exact_grant_retained");
      dispatched = true;
      return await runner({ ...request, ...lease.runner }, events);
    } catch (error) {
      if (!dispatched) {
        const failure = error instanceof WorkerCapabilityError ? error : new WorkerCapabilityError("worker_capabilities_failed");
        report(failure.code);
        throw failure;
      }
      throw error; // Preserve provider failures; never fall back after failed preparation.
    } finally {
      if (lease && typeof lease.release === "function") {
        try { await lease.release(); }
        catch { report("worker_capabilities_release_failed"); throw new WorkerCapabilityError("worker_capabilities_release_failed"); }
      }
    }
  };
}
