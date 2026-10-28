import type { RunnerEvents, RunnerRequest, RunnerResult } from "../runtime/runner";
import type { LocalModelHubControlPort } from "./ports";
import type { RuntimeToolPermissionAsk, RuntimeToolPermissionDecision } from "../runtime/tool-approval";
import type { PreparedMcpAdmission } from "../mcp-tools/prepared-transport";
import type { MainWorkFinish, MainWorkReference, MainWorkResult } from "../invocation/main-work-recovery";

/**
 * Every RunnerRequest field that holds a process-local value (a function, a class instance, a host-minted capability object), and
 * what crossing from Main to the daemon does with it. Every other field must be plain JSON data (assertLocalModelWireValue).
 *  - sender-owned: stays with the sender, which keeps it working across the boundary itself (the client links `signal` to run.cancel;
 *    the caller's common pump claims `ownerControlInbox` only after a definite remote result).
 *  - consumed-by-sender: the sender's own runner wrapper already applied it (withAgentContext runs in Main around this runner); a
 *    JSON copy would arrive as `{}`, a value that looks like a capability and is none.
 *  - relay: the receiving host mints a stand-in whose every call is answered by the sender's original over this protocol
 *    (`beforeMcpToolResult`: resultBoundaryGeneration; `canonicalWorkRecovery`: workRecoveryGeneration, work-recovery-relay.ts).
 *  - refuse: cannot be carried; such a run must enter the receiving host's own invocation service.
 * A field that is not listed and is not JSON data is refused as local_model_remote_value_invalid before anything is sent; the private
 * gate test-local-model-work-recovery-relay.cjs reads RunnerRequest's declared types and fails when such a field is missing here.
 */
export const LOCAL_MODEL_PROCESS_LOCAL_FIELDS = {
  signal: "sender-owned",
  ownerControlInbox: "sender-owned",
  agentContext: "consumed-by-sender",
  beforeMcpToolResult: "relay",
  canonicalWorkRecovery: "relay",
  scienceRecoveryCapability: "refuse",
  scienceCollectionCapability: "refuse",
  onAgentAppMcpRuntimeUnavailable: "refuse",
  historyRuntimeFence: "refuse",
} as const satisfies { readonly [K in keyof RunnerRequest]?: "sender-owned" | "consumed-by-sender" | "relay" | "refuse" };
type ProcessLocalField = keyof typeof LOCAL_MODEL_PROCESS_LOCAL_FIELDS;

/** An authenticated Desktop host sends this, never a renderer or model tool.
 * Opaque Science capabilities cannot be JSON-cloned. Such runs must enter the
 * daemon's invocation service, which mints/binds its own process-local grants.
 * Prepared MCP transports likewise require admission in the receiving host. */
export type RemoteLocalModelRunRequest = Omit<RunnerRequest, ProcessLocalField> & { [K in ProcessLocalField]?: never };

export type RemoteLocalModelRunEvent = {
  [K in keyof RunnerEvents]-?: { kind: K; args: Parameters<NonNullable<RunnerEvents[K]>> }
}[keyof RunnerEvents];

/** The service boot fences IDs and replay cursors across reconnects. A new
 * boot is not permission to restart a lost run; reconcile its durable receipt. */
export interface RemoteLocalModelRunScope { ownerEpoch: string; runId: string }
export interface RemoteMcpToolResultRequest extends RemoteLocalModelRunScope {
  clientId: string; generation: string; id: string; afterSequence: number;
  input: Parameters<NonNullable<RunnerRequest["beforeMcpToolResult"]>>[0];
}
/**
 * One call of the daemon-side Work journal port (work-recovery-relay.ts), answered by Main's MainWorkRecoveryContext. `handle` names
 * an admission Main holds; the daemon never sees or sends a journal unit.
 */
export type RemoteWorkRecoveryCall =
  | { op: "admit"; reference: MainWorkReference | null; methodId: string; arguments: Record<string, unknown>; observational: boolean; live: boolean }
  | { op: "finish"; handle: string; result: MainWorkResult; outcome: MainWorkFinish }
  | { op: "release"; handle: string }
  | { op: "endDispatch"; actionId: string; effectStarted: boolean }
  | { op: "packet"; always: boolean }
  | { op: "refusalPacket"; stepId: string | null }
  | { op: "unknownOutcomePacket"; actionIds: string[] };
/** A pending journal call on a run page. The call text (JSON of RemoteWorkRecoveryCall) is inline up to WORK_RELAY_INLINE_CHARS,
 * otherwise read with run.work-read; Main checks its length and sha256 before acting. */
export interface RemoteWorkRecoveryRequest extends RemoteLocalModelRunScope {
  clientId: string; generation: string; id: string; afterSequence: number;
  op: RemoteWorkRecoveryCall["op"]; chars: number; digest: string; payload?: string;
}
export const WORK_RELAY_INLINE_CHARS = 32_768;
/** One run.work / run.work-read chunk: at most 3 UTF-8 bytes per char after JSON escaping, inside the 2 MB request limit. */
export const WORK_RELAY_CHUNK_CHARS = 262_144;
/** A stored original result may be 32 MiB (main-work-recovery.ts MAX_RESULT_BYTES) plus its envelope. */
export const WORK_RELAY_MAX_CHARS = 48 * 1024 * 1024;
export interface RemoteLocalModelPermissionRequest {
  id: string;
  /** Authenticated receiver-authored family, never a field of the caller ask. */
  family: "direct" | "prepared-mcp-proxy";
  resourceDigest: string;
  ask: Omit<RuntimeToolPermissionAsk, "signal" | "consentBinding">;
}
export interface RemoteLocalModelRunPage extends RemoteLocalModelRunScope {
  schema: "agentlas.local-model-run-page.v1";
  state: "running" | "completed" | "cancelled" | "failed";
  events: Array<{ sequence: number; event: RemoteLocalModelRunEvent }>;
  nextSequence: number;
  permissionRequests?: RemoteLocalModelPermissionRequest[];
  mcpToolResults?: RemoteMcpToolResultRequest[];
  workRecoveryRequests?: RemoteWorkRecoveryRequest[];
  /** Receipt from the execution host after cancellation/rejected delivery. */
  runtimeQuiesced?: boolean;
  /** Never silently render a truncated stream as complete. */
  truncatedBeforeSequence: number;
  result: RunnerResult | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export type LocalModelControlCommand = {
  [K in keyof LocalModelHubControlPort]: { method: K; args: K extends "snapshot" ? []
    : K extends "searchModels" | "inspectRepository" | "addModel" ? [Parameters<LocalModelHubControlPort[K]>[0]]
    : K extends "importModel" | "loadModel" | "testCapabilities" | "toolProbeAsk" ? [Parameters<LocalModelHubControlPort[K]>[0], Parameters<LocalModelHubControlPort[K]>[1]]
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
  | { op: "run.start"; runId: string; request: RemoteLocalModelRunRequest; mcpAdmission?: PreparedMcpAdmission; resultBoundaryGeneration?: string; workRecoveryGeneration?: string }
  /** Probe before run.start: old daemons must not silently ignore the result hook. */
  | { op: "run.result-capability"; runId: string; generation: string }
  /** Probe before run.start: a daemon without the Work journal relay must refuse, never run a Work turn without the journal. */
  | { op: "run.work-recovery-capability"; runId: string; generation: string }
  | { op: "run.work-read"; runId: string; generation: string; requestId: string; offset: number }
  | { op: "run.work"; ownerEpoch: string; runId: string; generation: string; requestId: string; offset: number; text: string; chars: number; digest: string }
  | { op: "run.read"; runId: string; afterSequence: number; limit?: number; waitMs?: number }
  | { op: "run.cancel"; runId: string }
  | { op: "run.permission"; runId: string; approvalId: string; resourceDigest: string; decision: RuntimeToolPermissionDecision }
  | { op: "run.result"; ownerEpoch: string; runId: string; generation: string; resultId: string; allow: boolean }
  | { op: "run.ack"; runId: string; throughSequence: number }
  | { op: "client.detach" }
);
export type LocalModelRpcReply = { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } };

export function localModelRemoteError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Reject lost authority/callbacks before JSON serialization can silently erase
 * them (LOCAL_MODEL_PROCESS_LOCAL_FIELDS). Ordinary GUI MCP configurations also have process-local seals: their
 * preparation must move to the receiving invocation host, not be JSON-minted. Every refusal here precedes any dispatch. */
export function remoteLocalModelRequest(request: RunnerRequest | RemoteLocalModelRunRequest,
  options?: { mcpResultRelay?: true; workRecoveryRelay?: true }): RemoteLocalModelRunRequest {
  const wire: Record<string, unknown> = { ...request };
  for (const [key, disposition] of Object.entries(LOCAL_MODEL_PROCESS_LOCAL_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(wire, key)) continue;
    const value = wire[key];
    delete wire[key];
    if (value === undefined || disposition === "sender-owned" || disposition === "consumed-by-sender") continue;
    if (key === "beforeMcpToolResult") {
      if (typeof value !== "function" || !options?.mcpResultRelay) throw localModelRemoteError("local_model_remote_result_relay_required");
      continue;
    }
    if (key === "canonicalWorkRecovery") {
      if (!value || typeof value !== "object" || !options?.workRecoveryRelay) throw localModelRemoteError("local_model_remote_work_recovery_relay_required");
      continue;
    }
    throw localModelRemoteError("local_model_remote_process_binding_required", `Cannot transfer process-local binding: ${key}`);
  }
  if (wire.mcpConfigPath) throw localModelRemoteError("local_model_remote_mcp_admission_required");
  assertLocalModelWireValue(wire);
  if (typeof wire.systemPrompt !== "string" || typeof wire.userPrompt !== "string"
    || !Array.isArray(wire.history) || typeof wire.backendLabel !== "string"
    || !["ko", "en"].includes(wire.locale as string)) throw localModelRemoteError("local_model_remote_request_invalid");
  return wire as unknown as RemoteLocalModelRunRequest;
}

/** Codes thrown while a run request is assembled or checked, on either side, before the daemon launches anything: each is a
 * refusal before dispatch (runner-pre-dispatch.ts), never an unknown outcome. The daemon's run.start throws these only before
 * it registers and launches the run (daemon/local-model-rpc.ts). */
export const LOCAL_MODEL_PRE_LAUNCH_CODES: ReadonlySet<string> = new Set([
  "local_model_remote_result_relay_required", "local_model_remote_work_recovery_relay_required",
  "local_model_remote_process_binding_required", "local_model_remote_mcp_admission_required",
  "local_model_remote_value_invalid", "local_model_remote_request_invalid", "local_model_remote_id_invalid",
  "local_model_remote_admission_closed", "local_model_remote_capacity_exceeded",
]);

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
  start(input: RemoteLocalModelRunScope & { request: RemoteLocalModelRunRequest; mcpAdmission?: PreparedMcpAdmission; resultBoundaryGeneration?: string; workRecoveryGeneration?: string }): Promise<RemoteLocalModelRunPage>;
  read(input: RemoteLocalModelRunScope & { afterSequence: number; limit: number }): Promise<RemoteLocalModelRunPage>;
  cancel(input: RemoteLocalModelRunScope): Promise<{ requested: boolean }>;
  acknowledge(input: RemoteLocalModelRunScope & { throughSequence: number }): Promise<void>;
}
