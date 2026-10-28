import { getRuntimeToolPermissionArbiter, type RuntimeToolPermissionAsk, type RuntimeToolPermissionDecision } from "../runtime/tool-approval";
import { bindMainToolConsentResource } from "../runtime/tool-consent";
import { markAttemptQuiescenceUnconfirmed } from "../runtime/attempt-children";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDaemonRunning, type EnsureDaemonOptions } from "../daemon/app-launcher";
import { canonicalDaemonPath, daemonControlSocketPath, resolveDaemonServiceIdentity } from "../daemon/service-identity";
import type { InstallIdentity } from "../install-identity";
import type { DaemonLocalModelStatus } from "../daemon/local-model-service";
import type { RunnerEvents, RunnerResult } from "../runtime/runner";
import type { LocalModelHubControlPort, LocalModelHubRuntimePort, LocalModelRuntimeObservation } from "./ports";
import type { LocalModelHubSnapshot } from "../../shared/local-model-hub";
import { exportPreparedMcpAdmission, preparedMcpProxyScope, preparedMcpProxyScopeMatchesAsk } from "../mcp-tools/prepared-transport";
import { assertLocalModelWireValue, localModelRemoteError, remoteLocalModelRequest,
  LOCAL_MODEL_PRE_LAUNCH_CODES, WORK_RELAY_CHUNK_CHARS, WORK_RELAY_MAX_CHARS,
  type LocalModelControlCommand, type LocalModelControlPage, type LocalModelRpcCommand,
  type RemoteLocalModelRunPage, type RemoteLocalModelRunTransport, type RemoteWorkRecoveryRequest } from "./remote-contract";
import { assertMainWorkRecoveryContext, type MainWorkUnknownEnd } from "../invocation/main-work-recovery";
import { createMainWorkRecoveryRelayHost, workRelayDigest } from "./work-recovery-relay";

export interface LocalModelDaemonClientOptions extends EnsureDaemonOptions {
  storePath: string;
  installIdentity: InstallIdentity;
  requiredSchemaVersion: number;
  connectTimeoutMs?: number;
  /** GUI startup barrier: seeding and the shared daemon launch must finish
   * before a renderer snapshot or legacy migration can ask for this service. */
  startupReady?: Promise<void>;
}
export class LocalModelDaemonClientError extends Error {
  readonly code: string;
  constructor(readonly failure: { code: string; outcome: "not-dispatched" | "unknown" | "rejected";
    transportCode?: string; remoteMessage?: string; runId?: string; ownerEpoch?: string }) {
    super(failure.code); this.name = "LocalModelDaemonClientError"; this.code = failure.code;
  }
}
export interface LocalModelDaemonClient {
  ensureStarted(): Promise<DaemonLocalModelStatus>;
  control: LocalModelHubControlPort;
  runtime: LocalModelHubRuntimePort;
  /** Explicit replay/reconciliation, never an automatic restart of a lost run. */
  runs: RemoteLocalModelRunTransport;
  readonly clientId: string;
  /** Call before GUI-wide invocation abort. Cancels UI control operations but
   * leaves inference and the loaded engine owned by the daemon. */
  detach(): Promise<void>;
  /** Closes only this GUI's sockets. Does not unload or stop the service. */
  close(): void;
}
type VerifiedDaemon = { bootId: string; serviceIdentity: string };
const WORK_RELAY_OPS: ReadonlySet<string> = new Set(["admit", "finish", "release", "endDispatch", "packet", "refusalPacket", "unknownOutcomePacket"]);
const WORK_RELAY_CLOSING_OPS: ReadonlySet<string> = new Set(["finish", "release", "endDispatch"]);
/** The daemon refused a work read/answer because that request, its run or this client's admission already ended. */
const WORK_RELAY_ENDED_CODES: ReadonlySet<string> = new Set(["local_model_remote_work_refused", "local_model_remote_admission_closed",
  "local_model_remote_receipt_unavailable"]);
const STATES = ["running", "completed", "cancelled", "failed"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function failure(code: string, outcome: LocalModelDaemonClientError["failure"]["outcome"],
  details: Partial<LocalModelDaemonClientError["failure"]> = {}) {
  return new LocalModelDaemonClientError({ code, outcome, ...details });
}
/** RuntimeTurnDelivery "not-dispatched" (runner.ts markRefusedBeforeDispatch, read by runner-pre-dispatch.ts): this refusal came
 * before the daemon launched anything, so it is that refusal with its own code, never "sent but no completion receipt". */
function markNotDispatched<T>(error: T): T {
  if (error && typeof error === "object" && Object.isExtensible(error)) {
    try { Object.defineProperty(error, "turnDelivery", { value: "not-dispatched", enumerable: true, configurable: true, writable: true }); }
    catch { /* A sealed error keeps its own code and the caller's previous handling. */ }
  }
  return error;
}

/** Native-host facade, not a renderer-accessible generic RPC client. Uses the
 * same installation/store inode, protocol-v2 and exact boot fence as Science. */
export function createLocalModelDaemonClient(options: LocalModelDaemonClientOptions): LocalModelDaemonClient {
  if (!path.isAbsolute(options.userDataDir) || !path.isAbsolute(options.storePath)
    || !Number.isSafeInteger(options.requiredSchemaVersion) || options.requiredSchemaVersion < 1
    || (options.connectTimeoutMs !== undefined && (!Number.isSafeInteger(options.connectTimeoutMs)
      || options.connectTimeoutMs < 1 || options.connectTimeoutMs > 30_000))) throw failure("local_model_daemon_options_invalid", "not-dispatched");
  if (!fs.statSync(options.storePath).isFile()) throw failure("local_model_daemon_store_unavailable", "not-dispatched");
  const identity = resolveDaemonServiceIdentity(options);
  const socketPath = daemonControlSocketPath(identity.userDataDir);
  const clientId = randomUUID();
  const pending = new Set<() => void>();
  let closed = false;
  let detaching = false;
  let detachPromise: Promise<void> | null = null;
  let daemon: VerifiedDaemon | null = null;
  let ready: DaemonLocalModelStatus | null = null;
  let starting: Promise<DaemonLocalModelStatus> | null = null;
  let verifying: Promise<DaemonLocalModelStatus> | null = null;
  let observedSnapshot: { ownerEpoch: string; snapshot: LocalModelHubSnapshot } | null = null;
  let observationGeneration = 0;
  let observationFlight: Promise<LocalModelRuntimeObservation> | null = null;
  let snapshotFlight: Promise<LocalModelHubSnapshot> | null = null;

  function assertIdentity(): void {
    if (closed) throw failure("local_model_daemon_client_closed", "not-dispatched");
    try {
      if (!fs.statSync(identity.storePath).isFile()
        || resolveDaemonServiceIdentity(options).serviceIdentity !== identity.serviceIdentity) throw new Error("changed");
    } catch { throw failure("local_model_daemon_local_identity_changed", "not-dispatched"); }
  }
  function rpc(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    assertIdentity(); assertLocalModelWireValue(params);
    const id = randomUUID();
    const payload = `${JSON.stringify({ id, method, params })}\n`;
    if (Buffer.byteLength(payload) > 2 * 1024 * 1024) return Promise.reject(failure("local_model_daemon_request_too_large", "not-dispatched"));
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath); socket.setEncoding("utf8");
      let done = false; let sent = false; let buffer = "";
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error, result?: unknown) => {
        if (done) return; done = true; clearTimeout(timer); pending.delete(closeWait); socket.destroy();
        if (error) reject(error); else resolve(result);
      };
      const outcome = () => sent ? "unknown" as const : "not-dispatched" as const;
      const closeWait = () => finish(failure("local_model_daemon_client_closed", outcome()));
      pending.add(closeWait);
      timer = setTimeout(() => finish(failure("local_model_daemon_connect_timeout", "not-dispatched")), options.connectTimeoutMs ?? 3_000);
      socket.once("connect", () => {
        clearTimeout(timer);
        try { assertIdentity(); } catch (error) { finish(error as Error); return; }
        sent = true;
        timer = setTimeout(() => finish(failure("local_model_daemon_reply_timeout", "unknown")), timeoutMs);
        socket.write(payload);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { finish(failure("local_model_daemon_reply_too_large", outcome())); return; }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        let reply: Record<string, unknown> | null;
        try { reply = record(JSON.parse(buffer.slice(0, newline))); }
        catch { finish(failure("local_model_daemon_reply_invalid", outcome())); return; }
        if (!reply || reply.id !== id) { finish(failure("local_model_daemon_reply_identity_mismatch", outcome())); return; }
        const error = record(reply.error);
        if (error) finish(failure("local_model_daemon_remote_rejected", "rejected", {
          remoteMessage: typeof error.message === "string" ? error.message.slice(0, 2_000) : undefined,
        }));
        else if (Object.prototype.hasOwnProperty.call(reply, "result")) finish(undefined, reply.result);
        else finish(failure("local_model_daemon_reply_invalid", outcome()));
      });
      socket.once("error", (error: NodeJS.ErrnoException) => finish(failure("local_model_daemon_connection_failed", outcome(), { transportCode: error.code })));
      socket.once("end", () => finish(failure("local_model_daemon_connection_closed", outcome())));
      socket.once("close", () => finish(failure("local_model_daemon_connection_closed", outcome())));
    });
  }
  async function inspect(): Promise<VerifiedDaemon> {
    const ping = record(await rpc("daemon.ping", undefined, 5_000));
    if (!ping || ping.ok !== true || ping.serviceProtocolVersion !== 2 || ping.lifetime !== "service"
      || ping.processRole !== "desktop-daemon" || ping.controlSocketReady !== true) throw failure("local_model_daemon_protocol_incompatible", "not-dispatched");
    if (ping.version !== options.appVersion || ping.storeSchemaVersion !== options.requiredSchemaVersion) throw failure("local_model_daemon_version_mismatch", "not-dispatched");
    if (ping.serviceIdentity !== identity.serviceIdentity || typeof ping.storePath !== "string"
      || canonicalDaemonPath(ping.storePath) !== identity.storePath) throw failure("local_model_daemon_service_identity_mismatch", "not-dispatched");
    if (typeof ping.bootId !== "string" || !UUID.test(ping.bootId) || !Number.isSafeInteger(ping.pid)
      || Number(ping.pid) < 2) throw failure("local_model_daemon_boot_invalid", "not-dispatched");
    return { bootId: ping.bootId, serviceIdentity: identity.serviceIdentity };
  }
  function ensureStarted(): Promise<DaemonLocalModelStatus> {
    try {
      assertIdentity();
      if (detaching) throw failure("local_model_daemon_client_detached", "not-dispatched");
    } catch (error) { return Promise.reject(error); }
    if (starting) return starting;
    if (!ready) return startService();
    // What an earlier call attached to is not trusted blindly: the daemon may have died (memory pressure, a manual stop)
    // and been launched again on the same socket with a new boot id, and the service rejects every command that
    // carries the old one. A new call looks at the daemon that is up now, as the Science client does on every call.
    verifying ??= (async () => {
      const attached = daemon;
      const live = await inspect().then(value => value, () => null);
      if (closed || detaching) throw failure("local_model_daemon_client_detached", "not-dispatched");
      if (ready && attached && daemon === attached && live && live.bootId === attached.bootId) return ready;
      if (daemon === attached) { daemon = null; ready = null; }
      if (ready) return ready;
      return starting ?? startService();
    })().finally(() => { verifying = null; });
    return verifying;
  }
  function startService(): Promise<DaemonLocalModelStatus> {
    observedSnapshot = null;
    observationGeneration += 1;
    starting = (async () => {
      await options.startupReady;
      if (detaching || closed) throw failure("local_model_daemon_client_detached", "not-dispatched");
      // The launcher receives the GUI's diagnostic store digest in options.
      // Service identity is a separate stable value that it resolves itself;
      // replacing the digest with that value makes daemon.attach reject us.
      const result = await ensureDaemonRunning(options);
      if (result.status === "disabled" || result.status === "failed") throw failure("local_model_daemon_unavailable", "not-dispatched");
      const current = await inspect();
      const value = record(await rpc("localModel.start", current));
      if (!value || value.schema !== "agentlas.local-model-service-status.v1" || value.ownerEpoch !== current.bootId
        || value.state !== "ready" || typeof value.settled !== "boolean"
        || !Number.isSafeInteger(value.pendingOperations)) throw failure("local_model_daemon_status_invalid", "unknown");
      daemon = current; ready = value as unknown as DaemonLocalModelStatus;
      return ready;
    })().finally(() => { starting = null; });
    return starting;
  }
  async function command(command: LocalModelRpcCommand, ownerEpoch?: string, timeoutMs?: number): Promise<unknown> {
    if (!daemon) await ensureStarted();
    if (ownerEpoch !== undefined && daemon!.bootId !== ownerEpoch) throw failure("local_model_daemon_boot_changed", "not-dispatched");
    const reply = record(await rpc("localModel.command", { ...daemon!, command }, timeoutMs));
    if (reply?.ok === true && Object.prototype.hasOwnProperty.call(reply, "value")) return reply.value;
    const error = record(reply?.error);
    if (reply?.ok === false && typeof error?.code === "string") {
      throw failure(error.code, "rejected", { remoteMessage: typeof error.message === "string" ? error.message : undefined });
    }
    throw failure("local_model_daemon_command_reply_invalid", "unknown");
  }
  function checkPage(value: unknown, itemId: string, kind: "run" | "control") {
    const page = record(value);
    if (!page || page.schema !== `agentlas.local-model-${kind}-page.v1` || page.ownerEpoch !== daemon!.bootId
      || page[kind === "run" ? "runId" : "operationId"] !== itemId || !STATES.includes(String(page.state))
      || (page.errorCode !== null && typeof page.errorCode !== "string")) throw failure("local_model_daemon_page_invalid", "unknown");
    return page;
  }
  async function controlCall<K extends keyof LocalModelHubControlPort>(input: LocalModelControlCommand, signal?: AbortSignal): Promise<Awaited<ReturnType<LocalModelHubControlPort[K]>>> {
    if (detaching || closed) throw failure("local_model_daemon_client_detached", "not-dispatched");
    signal?.throwIfAborted();
    await ensureStarted(); signal?.throwIfAborted();
    const operationId = randomUUID();
    const scope = { clientId, operationId };
    let cancellation: Promise<unknown> | null = null;
    const abort = () => { if (!closed) cancellation ??= command({ op: "control.cancel", ...scope }).catch(error => error); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) abort();
      let page = checkPage(await command({ op: "control.start", ...scope, command: input }), operationId, "control") as unknown as LocalModelControlPage;
      while (page.state === "running") page = checkPage(await command({ op: "control.read", ...scope, waitMs: 25_000 }), operationId, "control") as unknown as LocalModelControlPage;
      if (page.state !== "completed") throw localModelRemoteError(page.errorCode ?? "local_model_remote_operation_failed", page.errorMessage ?? undefined);
      return page.result as Awaited<ReturnType<LocalModelHubControlPort[K]>>;
    } finally { signal?.removeEventListener("abort", abort); }
  }
  async function readSnapshot(): Promise<LocalModelHubSnapshot> {
    await ensureStarted();
    observedSnapshot = null;
    observationGeneration += 1;
    const epoch = daemon!.bootId;
    const generation = observationGeneration;
    const snapshot = await controlCall<"snapshot">({ method: "snapshot", args: [] });
    // Revalidate the live boot after the operation; a delayed old-daemon
    // page cannot become a current UI observation after restart or close.
    const current = await inspect();
    if (closed || detaching || generation !== observationGeneration || current.bootId !== epoch
      || daemon?.bootId !== epoch) {
      observedSnapshot = null;
      throw failure("local_model_daemon_boot_changed", "unknown");
    }
    observedSnapshot = { ownerEpoch: epoch, snapshot: structuredClone(snapshot) };
    return snapshot;
  }
  function snapshot(): Promise<LocalModelHubSnapshot> {
    if (snapshotFlight) return snapshotFlight;
    const flight = readSnapshot().finally(() => {
      if (snapshotFlight === flight) snapshotFlight = null;
    });
    snapshotFlight = flight;
    return flight;
  }
  const control: LocalModelHubControlPort = {
    snapshot,
    searchModels: input => controlCall<"searchModels">({ method: "searchModels", args: [input] }),
    inspectRepository: input => controlCall<"inspectRepository">({ method: "inspectRepository", args: [input] }),
    addModel: input => controlCall<"addModel">({ method: "addModel", args: [input] }),
    downloadEngine: (id, signal) => controlCall<"downloadEngine">({ method: "downloadEngine", args: [id] }, signal),
    downloadModel: (id, signal) => controlCall<"downloadModel">({ method: "downloadModel", args: [id] }, signal),
    importModel: (id, file, signal) => controlCall<"importModel">({ method: "importModel", args: [id, file] }, signal),
    installEngine: (id, signal) => controlCall<"installEngine">({ method: "installEngine", args: [id] }, signal),
    installDownloadedModel: (id, signal) => controlCall<"installDownloadedModel">({ method: "installDownloadedModel", args: [id] }, signal),
    loadModel: (id, context, signal) => controlCall<"loadModel">({ method: "loadModel", args: [id, context] }, signal),
    unload: (epoch, input) => controlCall<"unload">({ method: "unload", args: [epoch, input] }),
    testCapabilities: (id, selection, signal) => controlCall<"testCapabilities">({ method: "testCapabilities", args: [id, selection] }, signal),
  };
  const runs: RemoteLocalModelRunTransport = {
    start: async input => {
      const request = remoteLocalModelRequest(input.request);
      return checkPage(await command({ op: "run.start", clientId, runId: input.runId, request,
        ...(input.resultBoundaryGeneration ? { resultBoundaryGeneration: input.resultBoundaryGeneration } : {}),
        ...(input.workRecoveryGeneration ? { workRecoveryGeneration: input.workRecoveryGeneration } : {}),
        ...(input.mcpAdmission ? { mcpAdmission: input.mcpAdmission } : {}) }, input.ownerEpoch), input.runId, "run") as unknown as RemoteLocalModelRunPage;
    },
    read: async input => checkPage(await command({ op: "run.read", clientId, runId: input.runId,
      afterSequence: input.afterSequence, limit: input.limit, waitMs: 25_000 }, input.ownerEpoch), input.runId, "run") as unknown as RemoteLocalModelRunPage,
    cancel: async input => await command({ op: "run.cancel", clientId, runId: input.runId }, input.ownerEpoch) as { requested: boolean },
    acknowledge: async input => { await command({ op: "run.ack", clientId, runId: input.runId, throughSequence: input.throughSequence }, input.ownerEpoch); },
  };
  async function observeSnapshotUncached(): Promise<LocalModelRuntimeObservation> {
    if (closed || detaching) return { state: "pending", ownerEpoch: null, reasonCode: "local_model_daemon_client_detached" };
    const observed = observedSnapshot;
    if (observed && daemon?.bootId === observed.ownerEpoch) {
      const generation = observationGeneration;
      try {
        // Ping is observation only: no launcher, startup barrier, service
        // construction or localModel.start is reachable through this path.
        const current = await inspect();
        if (!closed && !detaching && generation === observationGeneration
          && observedSnapshot === observed && current.bootId === observed.ownerEpoch) {
          return { state: "observed", ownerEpoch: observed.ownerEpoch, snapshot: structuredClone(observed.snapshot) };
        }
        if (observedSnapshot === observed) observedSnapshot = null;
        return { state: "pending", ownerEpoch: closed || detaching ? null : current.bootId,
          reasonCode: closed || detaching ? "local_model_daemon_client_detached"
            : current.bootId !== observed.ownerEpoch ? "local_model_daemon_boot_changed" : "local_model_snapshot_pending" };
      } catch (error) {
        if (observedSnapshot === observed) observedSnapshot = null;
        return { state: "pending", ownerEpoch: null, reasonCode: error instanceof LocalModelDaemonClientError
          ? error.code : "local_model_observation_failed" };
      }
    }
    return { state: "pending", ownerEpoch: daemon?.bootId ?? null,
      reasonCode: starting ? "local_model_daemon_starting" : "local_model_snapshot_pending" };
  }
  function observeSnapshot(): Promise<LocalModelRuntimeObservation> {
    if (observationFlight) return observationFlight;
    const flight = observeSnapshotUncached().finally(() => {
      if (observationFlight === flight) observationFlight = null;
    });
    observationFlight = flight;
    return flight;
  }
  const runtime: LocalModelHubRuntimePort = {
    snapshot: control.snapshot,
    observeSnapshot,
    run: async (request, events) => {
      // Everything up to run.start precedes dispatch: a refusal here is that refusal (markNotDispatched), never an unknown outcome.
      let mcpAdmission: ReturnType<typeof exportPreparedMcpAdmission> | undefined;
      let proxyScope: ReturnType<typeof preparedMcpProxyScope> | undefined;
      let resultBoundaryGeneration: string | undefined, workRecoveryGeneration: string | undefined;
      let workRecoveryHost: ReturnType<typeof createMainWorkRecoveryRelayHost> | null = null;
      let wire: ReturnType<typeof remoteLocalModelRequest>;
      let preScope: { ownerEpoch: string; runId: string } | null = null;
      try {
        // Validate opaque fields before any daemon startup or request dispatch.
        mcpAdmission = request.mcpConfigPath ? exportPreparedMcpAdmission(request.mcpConfigPath) : undefined;
        proxyScope = request.mcpConfigPath ? preparedMcpProxyScope(request.mcpConfigPath) : undefined;
        // Move an opaque, validated host admission through the dedicated native
        // envelope. The ordinary wire contract still refuses any raw MCP path.
        resultBoundaryGeneration = request.beforeMcpToolResult ? randomUUID() : undefined;
        // The Work journal stays Main's: the daemon's loop gets a relay port answered by this exact context (work-recovery-relay.ts).
        if (request.canonicalWorkRecovery) {
          assertMainWorkRecoveryContext(request.canonicalWorkRecovery);
          workRecoveryGeneration = randomUUID();
        }
        wire = remoteLocalModelRequest({ ...request, mcpConfigPath: undefined }, {
          ...(resultBoundaryGeneration ? { mcpResultRelay: true as const } : {}),
          ...(workRecoveryGeneration ? { workRecoveryRelay: true as const } : {}) });
        request.signal?.throwIfAborted();
        const status = await ensureStarted(); request.signal?.throwIfAborted();
        preScope = { ownerEpoch: status.ownerEpoch, runId: randomUUID() };
        if (resultBoundaryGeneration) {
          // Same version/protocol does not prove this daemon implements the new
          // boundary. Negotiate before provider dispatch; no silent downgrade.
          let capability: Record<string, unknown> | null;
          try {
            capability = record(await command({ op: "run.result-capability", clientId,
              runId: preScope.runId, generation: resultBoundaryGeneration }, preScope.ownerEpoch, 5_000));
          } catch { throw failure("local_model_daemon_result_boundary_unsupported", "not-dispatched", preScope); }
          if (!capability || capability.schema !== "agentlas.local-model-result-boundary.v1"
            || capability.supported !== true || capability.ownerEpoch !== preScope.ownerEpoch
            || capability.clientId !== clientId || capability.runId !== preScope.runId
            || capability.generation !== resultBoundaryGeneration) {
            throw failure("local_model_daemon_result_boundary_unsupported", "not-dispatched", preScope);
          }
          request.signal?.throwIfAborted();
        }
        if (workRecoveryGeneration) {
          // A daemon without the relay would run the Work turn with no journal; it must refuse before anything is sent.
          let capability: Record<string, unknown> | null;
          try {
            capability = record(await command({ op: "run.work-recovery-capability", clientId,
              runId: preScope.runId, generation: workRecoveryGeneration }, preScope.ownerEpoch, 5_000));
          } catch { throw failure("local_model_daemon_work_recovery_unsupported", "not-dispatched", preScope); }
          if (!capability || capability.schema !== "agentlas.local-model-work-recovery-relay.v1"
            || capability.supported !== true || capability.ownerEpoch !== preScope.ownerEpoch
            || capability.clientId !== clientId || capability.runId !== preScope.runId
            || capability.generation !== workRecoveryGeneration) {
            throw failure("local_model_daemon_work_recovery_unsupported", "not-dispatched", preScope);
          }
          workRecoveryHost = createMainWorkRecoveryRelayHost(request.canonicalWorkRecovery!);
          request.signal?.throwIfAborted();
        }
      } catch (error) {
        throw markNotDispatched(error instanceof LocalModelDaemonClientError && preScope
          ? new LocalModelDaemonClientError({ ...error.failure, ...preScope }) : error);
      }
      const scope = preScope!;
      let cancelled = false;
      const abort = () => {
        if (detaching || closed || cancelled) return;
        cancelled = true;
        void runs.cancel(scope).catch(() => { /* Read/reconciliation reports the actual remote state. */ });
      };
      request.signal?.addEventListener("abort", abort, { once: true });
      let cursor = 0;
      const consumeEvents = async (page: RemoteLocalModelRunPage, deadline?: number): Promise<void> => {
        if (!Array.isArray(page.events) || !Number.isSafeInteger(page.nextSequence)
          || !Number.isSafeInteger(page.truncatedBeforeSequence) || page.truncatedBeforeSequence > cursor) {
          throw failure("local_model_daemon_stream_gap", "unknown", scope);
        }
        for (const row of page.events) {
          if (row.sequence !== cursor + 1 || !row.event || !Array.isArray(row.event.args)) throw failure("local_model_daemon_stream_invalid", "unknown", scope);
          const handler = events[row.event.kind] as ((...args: unknown[]) => void) | undefined;
          if (!["onPartial", "onStatus", "onTool", "onUsage", "onThinking", "onNotice"].includes(row.event.kind)) throw failure("local_model_daemon_stream_invalid", "unknown", scope);
          handler?.(...row.event.args.map(value => value === null ? undefined : value));
          cursor = row.sequence;
        }
        if (cursor !== page.nextSequence) throw failure("local_model_daemon_stream_invalid", "unknown", scope);
        if (page.events.length) {
          if (deadline !== undefined && Date.now() >= deadline) throw failure("local_model_daemon_quiescence_unconfirmed", "unknown", scope);
          await command({ op: "run.ack", clientId, runId: scope.runId, throughSequence: cursor }, scope.ownerEpoch,
            deadline === undefined ? undefined : Math.max(1, deadline - Date.now()));
        }
      };
      /** Answers the daemon loop's Work journal calls with Main's context (work-recovery-relay.ts). While draining after a stop only
       * the calls recording how an admitted call ended are answered (finish, release, dispatch end), so the journal keeps the end the
       * loop saw (a call that never left stays "not sent") instead of an unknown one. */
      const serveWorkRequests = async (page: RemoteLocalModelRunPage, closingOnly = false, deadline?: number): Promise<void> => {
        const list: RemoteWorkRecoveryRequest[] = page.workRecoveryRequests ?? [];
        if (!Array.isArray(list) || list.length > 16) throw failure("local_model_daemon_work_recovery_invalid", "unknown", scope);
        if (!list.length) return;
        if (!workRecoveryHost || !workRecoveryGeneration) throw failure("local_model_daemon_work_recovery_scope_mismatch", "unknown", scope);
        for (const pending of list) {
          if (!pending || !UUID.test(pending.id) || pending.ownerEpoch !== scope.ownerEpoch || pending.clientId !== clientId
            || pending.runId !== scope.runId || pending.generation !== workRecoveryGeneration
            || !Number.isSafeInteger(pending.afterSequence) || pending.afterSequence < 0 || !WORK_RELAY_OPS.has(pending.op)
            || !Number.isSafeInteger(pending.chars) || pending.chars < 2 || pending.chars > WORK_RELAY_MAX_CHARS
            || typeof pending.digest !== "string" || !/^[0-9a-f]{64}$/.test(pending.digest)
            || (pending.payload !== undefined && (typeof pending.payload !== "string" || pending.payload.length !== pending.chars))) {
            throw failure("local_model_daemon_work_recovery_scope_mismatch", "unknown", scope);
          }
          if ((closingOnly && !WORK_RELAY_CLOSING_OPS.has(pending.op)) || pending.afterSequence > cursor) continue;
          const timeout = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
          const ended = (error: unknown) => error instanceof LocalModelDaemonClientError && error.failure.outcome === "rejected"
            && WORK_RELAY_ENDED_CODES.has(error.code);
          let callText = pending.payload;
          try {
            while (callText === undefined || callText.length < pending.chars) {
              const chunk = record(await command({ op: "run.work-read", clientId, runId: scope.runId, generation: workRecoveryGeneration,
                requestId: pending.id, offset: callText?.length ?? 0 }, scope.ownerEpoch, timeout));
              if (!chunk || typeof chunk.text !== "string" || !chunk.text.length
                || (callText?.length ?? 0) + chunk.text.length > pending.chars) throw failure("local_model_daemon_work_recovery_invalid", "unknown", scope);
              callText = (callText ?? "") + chunk.text;
            }
          } catch (error) {
            // The call ended before it was read (its run stopped): there is nothing to answer and nothing was done for it.
            if (ended(error)) continue;
            throw error;
          }
          if (workRelayDigest(callText) !== pending.digest) throw failure("local_model_daemon_work_recovery_invalid", "unknown", scope);
          const answer = workRecoveryHost.answer(pending.id, callText, pending.op);
          const digest = workRelayDigest(answer);
          try {
            for (let offset = 0; offset < answer.length;) {
              const text = answer.slice(offset, offset + WORK_RELAY_CHUNK_CHARS);
              await command({ op: "run.work", clientId, ownerEpoch: scope.ownerEpoch, runId: scope.runId, generation: workRecoveryGeneration,
                requestId: pending.id, offset, text, chars: answer.length, digest }, scope.ownerEpoch, timeout);
              offset += text.length;
            }
          } catch (error) {
            // The daemon refused the answer because its request had already ended: its loop never received it.
            if (ended(error)) { workRecoveryHost.undelivered(pending.id); continue; }
            throw error;
          }
        }
      };
      const cancelAndDrain = async (): Promise<void> => {
        const deadline = Date.now() + 6_000;
        try {
          await command({ op: "run.cancel", clientId, runId: scope.runId }, scope.ownerEpoch, 6_000);
          while (Date.now() < deadline) {
            const remaining = Math.max(1, deadline - Date.now());
            const page = checkPage(await command({ op: "run.read", clientId, runId: scope.runId,
              afterSequence: cursor, limit: 128, waitMs: Math.min(1_000, remaining) }, scope.ownerEpoch, remaining), scope.runId, "run") as unknown as RemoteLocalModelRunPage;
            await consumeEvents(page, deadline);
            if (workRecoveryHost) await serveWorkRequests(page, true, deadline);
            if (page.state !== "running" && page.events.length === 0) {
              if (page.runtimeQuiesced !== true) markAttemptQuiescenceUnconfirmed();
              return;
            }
          }
        } catch { /* Preserve the original host rejection, but never infer termination. */ }
        markAttemptQuiescenceUnconfirmed();
      };
      let startRefused = false;
      let endCause: MainWorkUnknownEnd = "dispatch_ended";
      try {
        if (request.signal?.aborted) abort();
        let page: RemoteLocalModelRunPage;
        try { page = await runs.start({ ...scope, request: wire, mcpAdmission, resultBoundaryGeneration, workRecoveryGeneration }); }
        catch (error) {
          // Refused before the daemon registered and launched the run (remote-contract.ts LOCAL_MODEL_PRE_LAUNCH_CODES), or never sent.
          const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
          startRefused = error instanceof LocalModelDaemonClientError
            ? error.failure.outcome === "not-dispatched" || (error.failure.outcome === "rejected"
              && (LOCAL_MODEL_PRE_LAUNCH_CODES.has(code) || code === "local_model_daemon_remote_rejected"))
            : LOCAL_MODEL_PRE_LAUNCH_CODES.has(code);
          throw error;
        }
        const answeredPermissions = new Set<string>();
        const answeredResults = new Set<string>();
        for (;;) {
          if (!Array.isArray(page.permissionRequests ?? []) || (page.permissionRequests?.length ?? 0) > 16) {
            throw failure("local_model_daemon_permission_invalid", "unknown", scope);
          }
          for (const pending of page.permissionRequests ?? []) {
            if (!pending || !UUID.test(pending.id) || !/^[0-9a-f]{64}$/.test(pending.resourceDigest)
              || !pending.ask || typeof pending.ask !== "object") throw failure("local_model_daemon_permission_invalid", "unknown", scope);
            if (answeredPermissions.has(pending.id)) continue;
            const wireAsk = pending.ask;
            const proxy = pending.family === "prepared-mcp-proxy";
            const matchesScope = proxy ? Boolean(proxyScope && preparedMcpProxyScopeMatchesAsk(proxyScope, wireAsk)
                && wireAsk.kind === "other" && typeof wireAsk.tool === "string" && mcpAdmission?.servers.some(server =>
                  wireAsk.tool.startsWith(`mcp__${server.configKey}__`)))
              : pending.family === "direct" && wireAsk.runtime === "agentlas-local"
                && wireAsk.sessionKey === `agentlas-local:${request.sessionFingerprintSeed ?? request.cwd ?? "default"}`
                && wireAsk.permission === request.permission && wireAsk.cwd === request.cwd
                && wireAsk.chatId === (request.approvalChatId ?? request.chatId)
                && Boolean(wireAsk.planMode) === Boolean(request.planMode)
                && Boolean(wireAsk.unattended) === Boolean(request.unattended);
            if (typeof wireAsk.tool !== "string" || !wireAsk.tool || wireAsk.tool.length > 512
              || typeof wireAsk.kind !== "string" || typeof wireAsk.sessionKey !== "string"
              || typeof wireAsk.runtime !== "string" || typeof wireAsk.mutating !== "boolean"
              || !matchesScope
              || Object.prototype.hasOwnProperty.call(wireAsk, "consentBinding")
              || Object.prototype.hasOwnProperty.call(wireAsk, "signal")) {
              throw failure("local_model_daemon_permission_scope_mismatch", "unknown", scope);
            }
            let decision: RuntimeToolPermissionDecision = "deny";
            try {
              request.signal?.throwIfAborted();
              // Only this native client can mint the request object. Revalidate
              // the sender's original opaque seal before accepting a receiver
              // resource; a renderer JSON ask has no entry into this path.
              const assertPreparedCurrent = () => {
                if (request.mcpConfigPath) {
                  exportPreparedMcpAdmission(request.mcpConfigPath);
                  if (preparedMcpProxyScope(request.mcpConfigPath) !== proxyScope) throw new Error("mcp_prepared_scope_changed");
                }
              };
              assertPreparedCurrent();
              const ask: RuntimeToolPermissionAsk = { ...wireAsk,
                ...(request.signal ? { signal: request.signal } : {}) };
              bindMainToolConsentResource(ask, { nativeService: identity.serviceIdentity,
                resource: pending.resourceDigest, tool: ask.tool });
              const arbiter = getRuntimeToolPermissionArbiter();
              if (arbiter) {
                const signal = request.signal;
                if (!signal) decision = await arbiter(ask);
                else decision = await new Promise<RuntimeToolPermissionDecision>((resolve) => {
                  let done = false;
                  const finish = (value: RuntimeToolPermissionDecision) => {
                    if (done) return; done = true; signal.removeEventListener("abort", abort); resolve(value);
                  };
                  const abort = () => finish("deny");
                  signal.addEventListener("abort", abort, { once: true });
                  if (signal.aborted) abort();
                  else void arbiter(ask).then(finish, abort);
                });
              }
              request.signal?.throwIfAborted();
              assertPreparedCurrent();
            } catch { decision = "deny"; }
            answeredPermissions.add(pending.id);
            await command({ op: "run.permission", clientId, runId: scope.runId,
              approvalId: pending.id, resourceDigest: pending.resourceDigest, decision }, scope.ownerEpoch);
          }
          await consumeEvents(page);
          if (!Array.isArray(page.mcpToolResults ?? []) || (page.mcpToolResults?.length ?? 0) > 16) {
            throw failure("local_model_daemon_result_boundary_invalid", "unknown", scope);
          }
          for (const pending of page.mcpToolResults ?? []) {
            if (!pending || !UUID.test(pending.id) || pending.ownerEpoch !== scope.ownerEpoch
              || pending.clientId !== clientId || pending.runId !== scope.runId
              || !resultBoundaryGeneration || pending.generation !== resultBoundaryGeneration
              || !Number.isSafeInteger(pending.afterSequence) || pending.afterSequence < 0
              || !pending.input || (pending.input.catalogId !== null && (typeof pending.input.catalogId !== "string" || pending.input.catalogId.length > 512))
              || typeof pending.input.toolName !== "string" || !pending.input.toolName || pending.input.toolName.length > 512
              || typeof pending.input.isError !== "boolean" || !request.beforeMcpToolResult) {
              throw failure("local_model_daemon_result_boundary_scope_mismatch", "unknown", scope);
            }
            if (answeredResults.has(pending.id) || pending.afterSequence > cursor) continue;
            request.signal?.throwIfAborted();
            if (request.mcpConfigPath) {
              exportPreparedMcpAdmission(request.mcpConfigPath);
              if (preparedMcpProxyScope(request.mcpConfigPath) !== proxyScope) throw new Error("mcp_prepared_scope_changed");
            }
            try {
              await request.beforeMcpToolResult(pending.input);
              request.signal?.throwIfAborted();
              if (request.mcpConfigPath) {
                exportPreparedMcpAdmission(request.mcpConfigPath);
                if (preparedMcpProxyScope(request.mcpConfigPath) !== proxyScope) throw new Error("mcp_prepared_scope_changed");
              }
            } catch (error) {
              await command({ op: "run.result", clientId, ownerEpoch: scope.ownerEpoch, runId: scope.runId,
                generation: resultBoundaryGeneration, resultId: pending.id, allow: false }, scope.ownerEpoch, 1_000).catch(() => {});
              throw error;
            }
            await command({ op: "run.result", clientId, ownerEpoch: scope.ownerEpoch, runId: scope.runId,
              generation: resultBoundaryGeneration, resultId: pending.id, allow: true }, scope.ownerEpoch);
            answeredResults.add(pending.id);
            // Only current/recent page IDs are needed for replay coalescing.
            if (answeredResults.size > 32) answeredResults.delete(answeredResults.values().next().value!);
          }
          if (workRecoveryHost || (page.workRecoveryRequests?.length ?? 0) > 0) await serveWorkRequests(page);
          // A final page may still have a backlog. Read until an empty final
          // page before returning, so batching never drops the last tool/text.
          if (page.state !== "running" && page.events.length === 0) {
            if (page.state !== "completed") throw localModelRemoteError(page.errorCode ?? "local_model_remote_run_failed", page.errorMessage ?? undefined);
            if (!page.result || typeof page.result.text !== "string") throw failure("local_model_daemon_result_invalid", "unknown", scope);
            return page.result;
          }
          try { page = await runs.read({ ...scope, afterSequence: cursor, limit: 128 }); }
          catch (error) {
            if (!(error instanceof LocalModelDaemonClientError) || detaching || closed
              || !["local_model_daemon_connection_closed", "local_model_daemon_connection_failed"].includes(error.code)) throw error;
            const current = await inspect();
            if (current.bootId !== scope.ownerEpoch) throw failure("local_model_daemon_boot_changed", "unknown", scope);
            // Only a read is retried, once per disconnect. Never replay start.
            page = await runs.read({ ...scope, afterSequence: cursor, limit: 128 });
          }
        }
      } catch (error) {
        endCause = request.signal?.aborted ? "aborted"
          : error instanceof LocalModelDaemonClientError ? error.code === "local_model_daemon_boot_changed" ? "process_lost" : "transport"
          : "dispatch_ended";
        if (resultBoundaryGeneration || workRecoveryGeneration) await cancelAndDrain();
        const rethrown = error instanceof LocalModelDaemonClientError ? new LocalModelDaemonClientError({ ...error.failure, ...scope }) : error;
        throw startRefused ? markNotDispatched(rethrown) : rethrown;
      } finally {
        request.signal?.removeEventListener("abort", abort);
        // However the run ended here, no action this run admitted stays `started` in Main's journal.
        workRecoveryHost?.closeOpen(endCause);
      }
    },
  };
  function close(): void {
    detaching = true; closed = true;
    observedSnapshot = null; observationGeneration += 1;
    for (const cancel of [...pending]) cancel();
  }
  function detach(): Promise<void> {
    if (detachPromise) return detachPromise;
    detaching = true;
    observedSnapshot = null; observationGeneration += 1;
    detachPromise = (async () => {
      try {
        await starting?.catch(() => {});
        if (daemon && !closed) await command({ op: "client.detach", clientId });
      } finally { close(); }
    })();
    return detachPromise;
  }
  return { ensureStarted, control, runtime, runs, clientId, detach, close };
}
