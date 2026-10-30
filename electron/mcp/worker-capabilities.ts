import type { RuntimeStatus } from "../../shared/types";
import type { Runner, RunnerRequest } from "../runtime/runner";
import type { HostDelegatedGrant } from "./delegated-authority";

export type WorkerCapabilityRunnerFields = Partial<Pick<RunnerRequest,
  "mcpConfigPath" | "mcpAllowedTools" | "mcpCodexConfigArgs" | "env" | "isolatedMcpConfig" | "browserOnly">>;
export interface WorkerCapabilityInput {
  /** Host-local exact step authority, never derived from the capability selection model. */
  delegatedAuthority?: { grant: HostDelegatedGrant; runId: string; scopeKey: string };
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
  readonly turnDelivery?: "not-dispatched";
  readonly cleanupFailure?: unknown;
  constructor(readonly code: string, message = code, options?: { cause?: unknown; cleanupFailure?: unknown; turnDelivery?: "not-dispatched" }) {
    super(message, options); this.name = "WorkerCapabilityError"; this.turnDelivery = options?.turnDelivery;
    this.cleanupFailure = options?.cleanupFailure;
  }
}
/**
 * Codes of a preparation that failed before anything was dispatched and that can clear by themselves (a temp config racing its
 * cleanup, a tool server still starting, an unexpected exception inside the helper). One shared retry for every team path
 * (task force, firm, swarm). A changed boundary (scope-changed, a Stop, a vanished baseline) is not here: asking again would only
 * repeat the refusal.
 */
const TRANSIENT_PREPARATION_CODES: ReadonlySet<string> = new Set([
  "worker-capability-preparation-unavailable", "worker-capability-credential-or-server-unavailable", "worker_capabilities_failed",
]);
export const WORKER_PREPARATION_RETRY_DELAY_MS = 300;
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
    let completed = false;
    let pendingFailure: unknown;
    try {
      if (request.signal?.aborted) throw new WorkerCapabilityError("worker_capabilities_cancelled");
      const prepareOnce = () => prepare({ ...input, permission: request.permission, cwd: request.cwd, signal: request.signal });
      try { lease = await prepareOnce(); }
      catch (error) {
        // Nothing was dispatched, so asking once more is safe; once, and never after a Stop.
        if (!(error instanceof WorkerCapabilityError) || !TRANSIENT_PREPARATION_CODES.has(error.code) || request.signal?.aborted) throw error;
        report(`${error.code}:retrying`);
        await new Promise((resolve) => setTimeout(resolve, WORKER_PREPARATION_RETRY_DELAY_MS));
        if (request.signal?.aborted) throw new WorkerCapabilityError("worker_capabilities_cancelled");
        lease = await prepareOnce();
      }
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
      const result = await runner({ ...request, ...lease.runner }, events);
      completed = true;
      return result;
    } catch (error) {
      if (!dispatched) {
        const failure = new WorkerCapabilityError(error instanceof WorkerCapabilityError ? error.code : "worker_capabilities_failed",
          error instanceof WorkerCapabilityError ? error.message : "worker_capabilities_failed", { cause: error, turnDelivery: "not-dispatched" });
        pendingFailure = failure;
        report(failure.code);
        throw failure;
      }
      pendingFailure = error;
      throw error; // Preserve provider failures; never fall back after failed preparation.
    } finally {
      if (lease && typeof lease.release === "function") {
        try { await lease.release(); }
        catch (error) {
          report("worker_capabilities_release_failed");
          // A turn that completed is not undone by failing to clean up after it (a temp config already gone): the result stands and
          // the ledger records the cleanup failure. Failing the worker here threw away finished work for an internal cause.
          // Release can fail after real execution. Do not label it not-dispatched
          // or discard the original provider/transport observation.
          if (!completed) throw new WorkerCapabilityError("worker_capabilities_release_failed", "worker_capabilities_release_failed",
            { cause: pendingFailure ?? error, ...(pendingFailure ? { cleanupFailure: error } : {}),
              ...(!dispatched ? { turnDelivery: "not-dispatched" as const } : {}) });
        }
      }
    }
  };
}
