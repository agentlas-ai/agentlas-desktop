import type { RunnerEvents, RunnerRequest, RunnerResult } from "../runtime/runner";

/** An authenticated Desktop host sends this, never a renderer or model tool.
 * Opaque Science capabilities cannot be JSON-cloned. Such runs must enter the
 * daemon's invocation service, which mints/binds its own process-local grants.
 * Prepared MCP transports likewise require admission in the receiving host. */
export type RemoteLocalModelRunRequest = Omit<RunnerRequest,
  "signal" | "scienceRecoveryCapability" | "scienceCollectionCapability" | "onAgentAppMcpRuntimeUnavailable">
  & { signal?: never; scienceRecoveryCapability?: never; scienceCollectionCapability?: never;
    onAgentAppMcpRuntimeUnavailable?: never };

export type RemoteLocalModelRunEvent = {
  [K in keyof RunnerEvents]-?: { kind: K; args: Parameters<NonNullable<RunnerEvents[K]>> }
}[keyof RunnerEvents];

/** The service boot fences IDs and replay cursors across reconnects. A new
 * boot is not permission to restart a lost run; reconcile its durable receipt. */
export interface RemoteLocalModelRunScope { ownerEpoch: string; runId: string }
export interface RemoteLocalModelRunPage extends RemoteLocalModelRunScope {
  schema: "agentlas.local-model-run-page.v1";
  state: "running" | "completed" | "cancelled" | "failed";
  events: Array<{ sequence: number; event: RemoteLocalModelRunEvent }>;
  nextSequence: number;
  /** Never silently render a truncated stream as complete. */
  truncatedBeforeSequence: number;
  result: RunnerResult | null;
  errorCode: string | null;
}

/** Transport implementation must keep bounded replay buffers, coalesce an
 * identical runId/request pair, reject changed material, and keep cancel
 * callable after admission closes. Polling/subscription only observes: it
 * never resumes the agent or starts another inference. GUI detach must not
 * unload the daemon-owned engine. */
export interface RemoteLocalModelRunTransport {
  start(input: RemoteLocalModelRunScope & { request: RemoteLocalModelRunRequest }): Promise<RemoteLocalModelRunPage>;
  read(input: RemoteLocalModelRunScope & { afterSequence: number; limit: number }): Promise<RemoteLocalModelRunPage>;
  cancel(input: RemoteLocalModelRunScope): Promise<{ requested: boolean }>;
  acknowledge(input: RemoteLocalModelRunScope & { throughSequence: number }): Promise<void>;
}
