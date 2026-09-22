import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDaemonRunning, type EnsureDaemonOptions } from "../daemon/app-launcher";
import { canonicalDaemonPath, daemonControlSocketPath, resolveDaemonServiceIdentity } from "../daemon/service-identity";
import type { InstallIdentity } from "../install-identity";
import type { DaemonLocalModelStatus } from "../daemon/local-model-service";
import type { RunnerEvents, RunnerResult } from "../runtime/runner";
import type { LocalModelHubControlPort, LocalModelHubRuntimePort } from "./ports";
import { assertLocalModelWireValue, localModelRemoteError, remoteLocalModelRequest,
  type LocalModelControlCommand, type LocalModelControlPage, type LocalModelRpcCommand,
  type RemoteLocalModelRunPage, type RemoteLocalModelRunTransport } from "./remote-contract";

export interface LocalModelDaemonClientOptions extends EnsureDaemonOptions {
  storePath: string;
  installIdentity: InstallIdentity;
  requiredSchemaVersion: number;
  connectTimeoutMs?: number;
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
const STATES = ["running", "completed", "cancelled", "failed"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function failure(code: string, outcome: LocalModelDaemonClientError["failure"]["outcome"],
  details: Partial<LocalModelDaemonClientError["failure"]> = {}) {
  return new LocalModelDaemonClientError({ code, outcome, ...details });
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
    if (ready) return Promise.resolve(ready);
    if (starting) return starting;
    starting = (async () => {
      const result = await ensureDaemonRunning({ ...options, expectedStoreIdentity: identity.serviceIdentity });
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
  async function command(command: LocalModelRpcCommand, ownerEpoch?: string): Promise<unknown> {
    if (!daemon) await ensureStarted();
    if (ownerEpoch !== undefined && daemon!.bootId !== ownerEpoch) throw failure("local_model_daemon_boot_changed", "not-dispatched");
    const reply = record(await rpc("localModel.command", { ...daemon!, command }));
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
  const control: LocalModelHubControlPort = {
    snapshot: () => controlCall<"snapshot">({ method: "snapshot", args: [] }),
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
      return checkPage(await command({ op: "run.start", clientId, runId: input.runId, request }, input.ownerEpoch), input.runId, "run") as unknown as RemoteLocalModelRunPage;
    },
    read: async input => checkPage(await command({ op: "run.read", clientId, runId: input.runId,
      afterSequence: input.afterSequence, limit: input.limit, waitMs: 25_000 }, input.ownerEpoch), input.runId, "run") as unknown as RemoteLocalModelRunPage,
    cancel: async input => await command({ op: "run.cancel", clientId, runId: input.runId }, input.ownerEpoch) as { requested: boolean },
    acknowledge: async input => { await command({ op: "run.ack", clientId, runId: input.runId, throughSequence: input.throughSequence }, input.ownerEpoch); },
  };
  const runtime: LocalModelHubRuntimePort = {
    snapshot: control.snapshot,
    run: async (request, events) => {
      // Validate opaque fields before any daemon startup or request dispatch.
      const wire = remoteLocalModelRequest(request);
      request.signal?.throwIfAborted();
      const status = await ensureStarted(); request.signal?.throwIfAborted();
      const scope = { ownerEpoch: status.ownerEpoch, runId: randomUUID() };
      let cancelled = false;
      const abort = () => {
        if (detaching || closed || cancelled) return;
        cancelled = true;
        void runs.cancel(scope).catch(() => { /* Read/reconciliation reports the actual remote state. */ });
      };
      request.signal?.addEventListener("abort", abort, { once: true });
      try {
        if (request.signal?.aborted) abort();
        let page = await runs.start({ ...scope, request: wire });
        let cursor = 0;
        for (;;) {
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
          if (page.events.length) await runs.acknowledge({ ...scope, throughSequence: cursor });
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
        if (error instanceof LocalModelDaemonClientError) throw new LocalModelDaemonClientError({ ...error.failure, ...scope });
        throw error;
      } finally { request.signal?.removeEventListener("abort", abort); }
    },
  };
  function close(): void {
    detaching = true; closed = true;
    for (const cancel of [...pending]) cancel();
  }
  function detach(): Promise<void> {
    if (detachPromise) return detachPromise;
    detaching = true;
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
