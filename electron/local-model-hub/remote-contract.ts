import type { RunnerEvents, RunnerRequest, RunnerResult } from "../runtime/runner";
import type { LocalModelHubControlPort } from "./ports";

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
  errorMessage: string | null;
}

export type LocalModelControlCommand = {
  [K in keyof LocalModelHubControlPort]: { method: K; args: K extends "snapshot" ? []
    : K extends "searchModels" | "inspectRepository" | "addModel" ? [Parameters<LocalModelHubControlPort[K]>[0]]
    : K extends "importModel" | "loadModel" | "testCapabilities" ? [Parameters<LocalModelHubControlPort[K]>[0], Parameters<LocalModelHubControlPort[K]>[1]]
    : K extends "unload" ? Parameters<LocalModelHubControlPort[K]>
    : [Parameters<LocalModelHubControlPort[K]>[0]] }
}[keyof LocalModelHubControlPort];

export interface LocalModelControlPage {
  schema: "agentlas.local-model-control-page.v1";
  ownerEpoch: string;
  operationId: string;
  state: "running" | "completed" | "cancelled" | "failed";
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

/** All commands enter only through the native daemon's identity/boot guard. */
export type LocalModelRpcCommand = { clientId: string } & (
  | { op: "control.start"; operationId: string; command: LocalModelControlCommand }
  | { op: "control.read"; operationId: string; waitMs?: number }
  | { op: "control.cancel"; operationId: string }
  | { op: "run.start"; runId: string; request: RemoteLocalModelRunRequest }
  | { op: "run.read"; runId: string; afterSequence: number; limit?: number; waitMs?: number }
  | { op: "run.cancel"; runId: string }
  | { op: "run.ack"; runId: string; throughSequence: number }
  | { op: "client.detach" }
);
export type LocalModelRpcReply = { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } };

export function localModelRemoteError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Reject lost authority/callbacks before JSON serialization can silently erase
 * them. Ordinary GUI MCP configurations also have process-local seals: their
 * preparation must move to the receiving invocation host, not be JSON-minted. */
export function remoteLocalModelRequest(request: RunnerRequest | RemoteLocalModelRunRequest): RemoteLocalModelRunRequest {
  const { signal: _signal, ...wire } = request;
  for (const key of ["scienceRecoveryCapability", "scienceCollectionCapability", "onAgentAppMcpRuntimeUnavailable"] as const) {
    if (Object.prototype.hasOwnProperty.call(wire, key) && wire[key] !== undefined) {
      throw localModelRemoteError("local_model_remote_process_binding_required", `Cannot transfer process-local binding: ${key}`);
    }
  }
  if (wire.mcpConfigPath) throw localModelRemoteError("local_model_remote_mcp_admission_required");
  assertLocalModelWireValue(wire);
  if (typeof wire.systemPrompt !== "string" || typeof wire.userPrompt !== "string"
    || !Array.isArray(wire.history) || typeof wire.backendLabel !== "string"
    || !["ko", "en"].includes(wire.locale)) throw localModelRemoteError("local_model_remote_request_invalid");
  return wire as RemoteLocalModelRunRequest;
}

/** No toJSON hooks, functions, capabilities, cycles or unbounded nesting. */
export function assertLocalModelWireValue(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 64) throw localModelRemoteError("local_model_remote_value_invalid");
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || seen.has(value)
    || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length) throw localModelRemoteError("local_model_remote_value_invalid");
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) throw localModelRemoteError("local_model_remote_value_invalid");
    assertLocalModelWireValue(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
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
